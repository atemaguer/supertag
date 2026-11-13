//! Native lifecycle commands through the shipped binary: `init`, `up` in the background and
//! under a service unit, `down`, `ps`, `logs`, `status`, `version`, and `config`.
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    str::FromStr,
    sync::mpsc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection, Executor, PgConnection, postgres::PgConnectOptions};
use tempfile::TempDir;
use uuid::Uuid;

const BIN: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

/// A private machine: its own HOME, PATH, and state directory.
struct Machine {
    _temp: TempDir,
    home: PathBuf,
    state: PathBuf,
    bin: PathBuf,
    extra: Vec<(String, String)>,
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
            extra: Vec::new(),
        })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BIN);
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.bin.display()),
            )
            .env("TMPDIR", std::env::temp_dir())
            .envs(self.extra.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&self.home)
            .stdin(Stdio::null());
        command
    }

    fn run(&self, args: &[&str]) -> Result<Output> {
        let mut child = self
            .command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(150);
        loop {
            if child.try_wait()?.is_some() {
                return Ok(child.wait_with_output()?);
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let output = child.wait_with_output()?;
                anyhow::bail!(
                    "supertag {} timed out: {}{}",
                    args.join(" "),
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn ok(&self, args: &[&str]) -> Result<String> {
        let output = self.run(args)?;
        ensure!(
            output.status.success(),
            "supertag {} failed: {}{}\nsupervisor log:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            fs::read_to_string(self.state.join("logs/supervisor.log")).unwrap_or_default()
        );
        Ok(String::from_utf8(output.stdout)?)
    }

    fn fails(&self, args: &[&str]) -> Result<String> {
        let output = self.run(args)?;
        ensure!(
            !output.status.success(),
            "supertag {} unexpectedly succeeded: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout)
        );
        Ok(String::from_utf8(output.stderr)?)
    }

    fn ps(&self) -> Result<Value> {
        Ok(serde_json::from_str(
            &self.ok(&["ps", "--output", "json"])?,
        )?)
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        // Never leak a background supervisor from a failed assertion.
        if let Ok(text) = fs::read_to_string(self.state.join("supervisor.json"))
            && let Ok(status) = serde_json::from_str::<Value>(&text)
            && let Some(pid) = status["pid"].as_i64()
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            let deadline = Instant::now() + WAIT;
            while alive(pid as u32) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn pids(ps: &Value) -> Vec<u32> {
    let mut pids: Vec<u32> = ps["services"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|service| service["pid"].as_u64().map(|pid| pid as u32))
        .collect();
    if let Some(pid) = ps["supervisor"]["pid"].as_u64() {
        pids.push(pid as u32);
    }
    pids
}

fn service<'a>(ps: &'a Value, name: &str) -> Result<&'a Value> {
    ps["services"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|service| service["service"] == name)
        .with_context(|| format!("service {name} missing from {ps}"))
}

fn wait_gone(pids: &[u32]) -> Result<()> {
    let deadline = Instant::now() + WAIT;
    while pids.iter().any(|pid| alive(*pid)) {
        ensure!(
            Instant::now() < deadline,
            "processes {pids:?} outlived supertag down"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn write_yaml(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[test]
fn background_up_runs_until_down_and_reports_through_ps_logs_status_and_version() -> Result<()> {
    let machine = Machine::new()?;
    let state = machine.state.to_str().unwrap().to_owned();
    assert!(
        machine
            .ok(&["ps"])?
            .contains("SuperTag is not running on this machine.")
    );
    assert!(
        machine
            .ok(&["down"])?
            .contains("SuperTag is not running on this machine.")
    );
    let up = ["up", "--adapter", ADAPTER];

    let started = machine.ok(&up)?;
    assert!(
        started.contains("Started SuperTag in the background"),
        "{started}"
    );
    let ps = machine.ps()?;
    assert_eq!(ps["supervisor"]["mode"], "background");
    for name in ["control-plane", "gateway", "local"] {
        assert_eq!(service(&ps, name)?["state"], "running", "{ps}");
    }
    let host = service(&ps, "local")?;
    assert_eq!(host["connected"], true, "{ps}");
    assert_eq!(host["draining"], false, "{ps}");
    let first = pids(&ps);
    assert_eq!(first.len(), 4);
    assert!(first.iter().all(|pid| alive(*pid)));
    let text = machine.ok(&["ps"])?;
    assert!(
        text.contains("SERVICE") && text.contains("local") && text.contains("connected"),
        "{text}"
    );

    // An unchanged `up` leaves the running supervisor alone.
    let again = machine.ok(&up)?;
    assert!(again.contains("left alone"), "{again}");
    assert_eq!(pids(&machine.ps()?), first);

    // The operator API answers through the background services.
    let gateway = ["--state-directory", &state];
    let tag = machine.ok(&[
        &["tag", "put"][..],
        &gateway,
        &["lead", "--instructions", "Lead."],
    ]
    .concat())?;
    assert!(tag.contains("\"lead\""), "{tag}");
    let status: Value = serde_json::from_str(&machine.ok(&["status", "--output", "json"])?)?;
    assert_eq!(status["worker_hosts"][0]["id"], "local", "{status}");
    assert_eq!(status["tags"][0]["id"], "lead", "{status}");
    assert_eq!(status["inbox"]["items"], 0);
    let text = machine.ok(&["status"])?;
    assert!(text.starts_with("Worker Hosts\n  local  ready"), "{text}");
    assert!(text.contains("\nTags\n  lead  any harness\n"), "{text}");

    let version: Value = serde_json::from_str(&machine.ok(&["version", "--output", "json"])?)?;
    assert_eq!(version["cli"], env!("CARGO_PKG_VERSION"));
    assert_eq!(version["local_services"]["running"], true);
    assert_eq!(version["local_services"]["matches_cli"], true);
    assert!(
        machine
            .ok(&["--version"])?
            .contains(env!("CARGO_PKG_VERSION"))
    );

    // Each service logs to its own file; several are prefixed with their names.
    let endpoint = status_endpoint(&machine)?;
    let logs = machine.ok(&["logs"])?;
    assert!(logs.contains(&format!("supervisor | {endpoint}")), "{logs}");
    assert_eq!(machine.ok(&["logs", "supervisor"])?.trim(), endpoint);
    assert!(machine.state.join("logs/hosts/local.log").exists());
    assert!(
        machine
            .fails(&["logs", "nope"])?
            .contains("nope is not a service")
    );
    let mut follow = machine
        .command(&["logs", "-f", "supervisor"])
        .stdout(Stdio::piped())
        .spawn()?;
    let line = first_line(&mut follow)?;
    assert_eq!(line.trim(), endpoint);
    unsafe {
        libc::kill(follow.id() as i32, libc::SIGTERM);
    }
    ensure!(follow.wait()?.success(), "logs -f did not stop cleanly");

    // Down drains the local host, stops everything, and the next up returns it to service.
    let down = machine.ok(&["down"])?;
    assert!(down.contains("Stopped SuperTag"), "{down}");
    wait_gone(&first)?;
    assert!(machine.ok(&["ps"])?.contains("not running"));
    let version: Value = serde_json::from_str(&machine.ok(&["version", "--output", "json"])?)?;
    assert_eq!(version["local_services"]["running"], false);
    assert!(!machine.state.join("supervisor.json").exists());
    assert!(!machine.state.join("endpoint").exists());
    assert!(machine.fails(&["status"])?.contains("not running"));

    machine.ok(&up)?;
    let ps = machine.ps()?;
    assert_eq!(service(&ps, "local")?["draining"], false, "{ps}");
    assert!(!machine.state.join("drained-hosts").exists());
    let second = pids(&ps);
    assert!(second.iter().all(|pid| !first.contains(pid)));

    // Changed flags restart the supervisor.
    let restarted = machine.ok(&[
        "up",
        "--adapter",
        ADAPTER,
        "--gateway-listen",
        "127.0.0.1:0",
    ])?;
    assert!(restarted.contains("settings changed"), "{restarted}");
    wait_gone(&second)?;
    let third = pids(&machine.ps()?);
    machine.ok(&["down", "--force"])?;
    wait_gone(&third)?;
    Ok(())
}

fn status_endpoint(machine: &Machine) -> Result<String> {
    let status: Value =
        serde_json::from_str(&fs::read_to_string(machine.state.join("supervisor.json"))?)?;
    Ok(status["endpoint"].as_str().context("endpoint")?.to_owned())
}

fn first_line(child: &mut Child) -> Result<String> {
    let stdout = child.stdout.take().context("stdout")?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = send.send(line);
    });
    Ok(receive.recv_timeout(WAIT)?)
}

#[test]
fn configured_services_restart_on_change_render_config_and_refuse_unknown_names() -> Result<()> {
    let machine = Machine::new()?;
    fs::create_dir_all(&machine.state)?;
    fs::set_permissions(&machine.state, fs::Permissions::from_mode(0o700))?;
    let file = machine.state.join("supertag.yaml");
    let mut config = json!({
        "name": "lifecycle",
        "services": {
            "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"]},
            "builder": {"type": "host", "adapter": ADAPTER},
        },
    });
    assert!(
        machine
            .fails(&["config"])?
            .contains("supertag init writes one")
    );
    write_yaml(&file, &config)?;
    let rendered = machine.ok(&["config"])?;
    assert!(
        rendered.starts_with(&format!("# {}\n", file.canonicalize()?.display())),
        "{rendered}"
    );
    assert!(rendered.contains("name: lifecycle\n"), "{rendered}");
    assert!(rendered.contains("  builder:\n    adapter: "), "{rendered}");
    assert!(rendered.contains("    restart: \"no\"\n"), "{rendered}");
    assert!(rendered.contains("version: 1\n"), "{rendered}");
    assert_eq!(
        machine.ok(&["config", "--services"])?,
        "builder\ncontrol-plane\n"
    );

    machine.ok(&["up"])?;
    let ps = machine.ps()?;
    assert_eq!(service(&ps, "builder")?["state"], "running", "{ps}");
    assert_eq!(service(&ps, "builder")?["worker_host_id"], "builder");
    let first = pids(&ps);
    assert!(machine.ok(&["up"])?.contains("left alone"));

    // A changed file restarts the supervisor with the new services.
    config["services"]["reviewer"] = json!({"type": "host", "adapter": ADAPTER});
    write_yaml(&file, &config)?;
    assert!(machine.ok(&["config", "--services"])?.contains("reviewer"));
    assert!(machine.ok(&["up"])?.contains("settings changed"));
    wait_gone(&first)?;
    let ps = machine.ps()?;
    assert_eq!(service(&ps, "reviewer")?["state"], "running", "{ps}");
    assert!(machine.state.join("logs/hosts/reviewer.log").exists());
    machine.ok(&["logs", "reviewer"])?;

    // --force restarts a changed file without waiting, and the new supervisor starts.
    let second = pids(&ps);
    config["services"]["checker"] = json!({"type": "host", "adapter": ADAPTER});
    write_yaml(&file, &config)?;
    let forced = machine.ok(&["up", "--force"])?;
    assert!(forced.contains("settings changed"), "{forced}");
    assert!(forced.contains("Started SuperTag"), "{forced}");
    wait_gone(&second)?;
    let ps = machine.ps()?;
    assert_eq!(service(&ps, "checker")?["state"], "running", "{ps}");
    assert!(machine.ok(&["up", "--force"])?.contains("left alone"));

    // Host names never collide with the fixed services' logs.
    let mut reserved = config.clone();
    reserved["services"]["gateway"] = json!({"type": "host", "adapter": ADAPTER});
    let reserved_file = machine.home.join("reserved.yaml");
    write_yaml(&reserved_file, &reserved)?;
    assert!(
        machine
            .fails(&["config", "--file", reserved_file.to_str().unwrap()])?
            .contains("a host cannot be named gateway")
    );

    let second = pids(&ps);
    machine.ok(&["down"])?;
    wait_gone(&second)?;
    // Stopped configured services are still listed from the file.
    let ps = machine.ps()?;
    assert!(ps["supervisor"].is_null());
    assert_eq!(service(&ps, "reviewer")?["state"], "stopped");

    // An invalid file fails before anything starts.
    fs::write(&file, "services: {broken: {type: nope}}\n")?;
    assert!(machine.fails(&["up"])?.contains("invalid or unsupported"));
    assert!(
        machine
            .fails(&["config"])?
            .contains("invalid or unsupported")
    );
    assert!(machine.ok(&["ps"])?.contains("not running"));
    Ok(())
}

#[cfg(target_os = "macos")]
const FAKE_LAUNCHCTL: &str = r#"#!/bin/sh
# Records calls and runs a LaunchAgent's program directly instead of in the user's session.
dir="$FAKE_LAUNCHD_DIR"
echo "$*" >> "$dir/calls"
label_of() { echo "${1##*/}"; }
case "$1" in
  print)
    pid=$(cat "$dir/$(label_of "$2").pid" 2>/dev/null) || exit 113
    kill -0 "$pid" 2>/dev/null || exit 113
    ;;
  bootstrap)
    plist="$3"
    /usr/bin/plutil -lint "$plist" >/dev/null || exit 5
    label=$(/usr/bin/plutil -extract Label raw -o - "$plist") || exit 5
    out=$(/usr/bin/plutil -extract StandardOutPath raw -o - "$plist") || exit 5
    wd=$(/usr/bin/plutil -extract WorkingDirectory raw -o - "$plist") || exit 5
    p=$(/usr/bin/plutil -extract EnvironmentVariables.PATH raw -o - "$plist")
    h=$(/usr/bin/plutil -extract EnvironmentVariables.HOME raw -o - "$plist")
    m=$(/usr/bin/plutil -extract EnvironmentVariables.SUPERTAG_SUPERVISOR_MODE raw -o - "$plist")
    set --
    i=0
    while arg=$(/usr/bin/plutil -extract "ProgramArguments.$i" raw -o - "$plist" 2>/dev/null); do
      set -- "$@" "$arg"
      i=$((i + 1))
    done
    (cd "$wd" && exec env -i PATH="$p" HOME="$h" SUPERTAG_SUPERVISOR_MODE="$m" "$@") >>"$out" 2>&1 </dev/null &
    echo $! > "$dir/$label.pid"
    ;;
  bootout)
    label=$(label_of "$2")
    pid=$(cat "$dir/$label.pid" 2>/dev/null) || exit 113
    kill -TERM "$pid" 2>/dev/null
    i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 900 ]; do sleep 0.1; i=$((i + 1)); done
    rm -f "$dir/$label.pid"
    ;;
  *) exit 64 ;;
esac
"#;

/// Put the recording launchctl on this machine's PATH; returns where it records calls.
#[cfg(target_os = "macos")]
fn fake_launchd(machine: &mut Machine) -> Result<PathBuf> {
    let launchd = machine.home.join("fake-launchd");
    fs::create_dir_all(&launchd)?;
    let fake = machine.bin.join("launchctl");
    fs::write(&fake, FAKE_LAUNCHCTL)?;
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755))?;
    machine
        .extra
        .push(("FAKE_LAUNCHD_DIR".into(), launchd.to_str().unwrap().into()));
    Ok(launchd)
}

/// A private state directory holding a supertag.yaml.
#[cfg(target_os = "macos")]
fn state_with(directory: &Path, config: &Value) -> Result<PathBuf> {
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let file = directory.join("supertag.yaml");
    write_yaml(&file, config)?;
    Ok(file)
}

#[cfg(target_os = "macos")]
#[test]
fn restart_unless_stopped_installs_a_launchd_unit_that_down_stops_and_removes() -> Result<()> {
    let mut machine = Machine::new()?;
    let launchd = fake_launchd(&mut machine)?;
    fs::create_dir_all(&machine.state)?;
    fs::set_permissions(&machine.state, fs::Permissions::from_mode(0o700))?;
    let file = machine.state.join("supertag.yaml");
    write_yaml(
        &file,
        &json!({
            "name": "unit-test",
            "services": {
                "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"], "restart": "unless-stopped"},
                "builder": {"type": "host", "adapter": ADAPTER, "restart": "unless-stopped"},
            },
        }),
    )?;
    let plist = machine
        .home
        .join("Library/LaunchAgents/ai.supertag.unit-test.plist");

    let up = machine.ok(&["up"])?;
    assert!(
        up.contains(&format!("Installed {}", plist.display())),
        "{up}"
    );
    assert!(up.contains("under its service unit"), "{up}");
    let text = fs::read_to_string(&plist)?;
    assert!(text.contains("<string>--foreground</string>"), "{text}");
    assert!(
        text.contains(&format!(
            "<string>{}</string>",
            file.canonicalize()?.display()
        )),
        "{text}"
    );
    let ps = machine.ps()?;
    assert_eq!(ps["supervisor"]["mode"], "service");
    assert_eq!(ps["supervisor"]["unit"], plist.to_str().unwrap());
    assert_eq!(service(&ps, "builder")?["state"], "running", "{ps}");
    let first = pids(&ps);
    assert!(machine.ok(&["up"])?.contains("left alone"));

    let down = machine.ok(&["down"])?;
    assert!(
        down.contains("Its service unit starts it again when you log in"),
        "{down}"
    );
    wait_gone(&first)?;
    assert!(
        plist.exists(),
        "down without --remove-services keeps the unit"
    );
    let calls = fs::read_to_string(launchd.join("calls"))?;
    assert!(calls.contains("bootout gui/"), "{calls}");

    let removed = machine.ok(&["down", "--remove-services"])?;
    assert!(removed.contains("Removed service unit"), "{removed}");
    assert!(!plist.exists());
    assert!(machine.ok(&["down"])?.contains("not running"));
    Ok(())
}

#[test]
fn init_checks_for_a_harness_first_then_writes_configuration_and_starts_services() -> Result<()> {
    let machine = Machine::new()?;
    let repository = machine.home.join("My Project");
    fs::create_dir_all(&repository)?;
    let git = |args: &[&str]| -> Result<()> {
        let status = Command::new("git")
            .args(args)
            .current_dir(&repository)
            .env("HOME", &machine.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdout(Stdio::null())
            .status()?;
        ensure!(status.success(), "git {args:?} failed");
        Ok(())
    };
    let init = |args: &[&str]| {
        let mut command = machine.command(&[&["init"][..], args].concat());
        command.current_dir(&repository);
        command.output()
    };

    // No harness: guidance and no side effect.
    let output = init(&["--yes"])?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("none was found"));
    assert!(!machine.state.exists());

    // A harness on PATH, but no terminal and no --yes.
    let codex = machine.bin.join("codex");
    fs::write(
        &codex,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.163.0; fi\nexit 0\n",
    )?;
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o755))?;
    let output = init(&[])?;
    assert!(String::from_utf8_lossy(&output.stderr).contains("needs a terminal"));
    let output = init(&["--yes"])?;
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("git repository"),
        "{output:?}"
    );
    git(&["init", "-q", "-b", "main"])?;
    let output = init(&["--yes"])?;
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("no commits"),
        "{output:?}"
    );
    fs::write(repository.join("README.md"), "fixture\n")?;
    git(&["add", "README.md"])?;
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "first",
    ])?;
    assert!(!machine.state.exists());

    // Codex has no credential the Worker Host could use: nothing is written, and the steps say
    // how to sign in.
    let output = init(&["--yes"])?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(
        stderr.contains("No selected harness could complete the sign-in check"),
        "{stderr}"
    );
    assert!(
        stderr.contains("codex -c 'cli_auth_credentials_store=\"file\"' login"),
        "{stderr}"
    );
    assert!(!machine.state.join("supertag.yaml").exists());
    // A file-backed Codex login is checked without a model turn.
    fs::create_dir_all(machine.home.join(".codex"))?;
    fs::write(
        machine.home.join(".codex/auth.json"),
        r#"{"tokens":{"refresh_token":"refresh"}}"#,
    )?;

    let output = init(&["--yes"])?;
    ensure!(
        output.status.success(),
        "init failed: {}{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        fs::read_to_string(machine.state.join("logs/supervisor.log")).unwrap_or_default()
    );
    let stdout = String::from_utf8(output.stdout)?;
    assert!(
        stdout.contains("Started SuperTag in the background"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Tag lead runs codex on this machine, in Workspace my-project"),
        "{stdout}"
    );
    assert!(stdout.contains("  codex: signed in"), "{stdout}");
    let file = machine.state.join("supertag.yaml");
    assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o600);
    let services = machine.ok(&["config", "--services"])?;
    let names: Vec<&str> = services.lines().collect();
    assert_eq!(names.len(), 2, "{services}");
    assert!(names.contains(&"control-plane"));
    let host = names
        .iter()
        .find(|name| **name != "control-plane")
        .unwrap()
        .to_string();
    let rendered = machine.ok(&["config"])?;
    assert!(rendered.contains("      - codex\n"), "{rendered}");
    assert!(
        rendered.contains(&format!(
            "      my-project: {}",
            repository.canonicalize()?.display()
        )) || rendered.contains("my-project: \""),
        "{rendered}"
    );

    let ps = machine.ps()?;
    assert_eq!(service(&ps, &host)?["state"], "running", "{ps}");
    let state = machine.state.to_str().unwrap().to_owned();
    let tag: Value =
        serde_json::from_str(&machine.ok(&["get", "tag", "--state-directory", &state, "lead"])?)?;
    assert_eq!(tag["harness"], "HARNESS_KIND_CODEX", "{tag}");

    // A second init keeps the setup and leaves the running services alone.
    let first = pids(&ps);
    let output = init(&["--yes"])?;
    let again = String::from_utf8(output.stdout)?;
    assert!(again.contains("already set up"), "{again}");
    assert!(again.contains("left alone"), "{again}");
    assert_eq!(pids(&machine.ps()?), first);

    machine.ok(&["down"])?;
    wait_gone(&first)?;
    Ok(())
}

/// Starts a separate Control Plane and Gateway on `database` and a fixture Worker Host.
struct SplitServices {
    children: Vec<Child>,
    endpoint: String,
    operator: String,
    _temp: TempDir,
}

impl Drop for SplitServices {
    fn drop(&mut self) {
        for child in self.children.iter_mut().rev() {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let _ = child.wait();
        }
    }
}

fn spawn_ready(mut command: Command, log: &Path) -> Result<(Child, String)> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(fs::File::create(log)?)
        .spawn()?;
    match first_line(&mut child) {
        Ok(line) if !line.trim().is_empty() => Ok((child, line.trim().to_owned())),
        _ => {
            let _ = child.kill();
            anyhow::bail!("service did not start: {}", fs::read_to_string(log)?)
        }
    }
}

impl SplitServices {
    fn start(database: &str) -> Result<Self> {
        let temp = TempDir::new()?;
        let token = || format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let (gateway_token, operator, host) = (token(), token(), token());
        let base = |args: &[&str]| {
            let mut command = Command::new(BIN);
            command.args(args).env_clear().env("PATH", "/usr/bin:/bin");
            command
        };
        let mut plane = base(&["control-plane"]);
        plane
            .env("SUPERTAG_DATABASE_URL", database)
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host);
        let (plane, private) = spawn_ready(plane, &temp.path().join("plane.log"))?;
        let mut children = vec![plane];
        let private = format!("http://{private}");
        let mut gateway = base(&["gateway", "--control-plane", &private]);
        gateway
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator);
        let (gateway, endpoint) = spawn_ready(gateway, &temp.path().join("gateway.log"))?;
        let endpoint = format!("http://{endpoint}");
        children.push(gateway);
        let mut worker = base(&["worker-host", "--gateway", &endpoint, "--adapter", ADAPTER]);
        worker
            .arg("--state-directory")
            .arg(temp.path().join("host"))
            .env("SUPERTAG_HOST_TOKEN", &host);
        let (worker, ready) = spawn_ready(worker, &temp.path().join("host.log"))?;
        ensure!(ready == "ready", "{ready}");
        children.push(worker);
        Ok(Self {
            children,
            endpoint,
            operator,
            _temp: temp,
        })
    }

    fn cli(&self, args: &[&str]) -> Result<String> {
        let output = Command::new(BIN)
            .args(args)
            .env_clear()
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .stdin(Stdio::null())
            .output()?;
        ensure!(
            output.status.success(),
            "supertag {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(String::from_utf8(output.stdout)?)
    }
}

fn exercise_status(database: &str) -> Result<()> {
    let services = SplitServices::start(database)?;
    let gateway = services.endpoint.clone();
    let temp = TempDir::new()?;
    let manifest = temp.path().join("organization.yaml");
    fs::write(
        &manifest,
        "apiVersion: supertag/v1\nkind: Tag\nmetadata: {name: owner}\nspec: {instructions: Own it.}\n---\napiVersion: supertag/v1\nkind: Objective\nmetadata: {name: ship-it}\nspec: {ownerTag: owner, ongoing: true, outcome: Ship the fixture.}\n",
    )?;
    services.cli(&[
        "apply",
        "--gateway",
        &gateway,
        "-f",
        manifest.to_str().unwrap(),
    ])?;
    let deadline = Instant::now() + WAIT;
    let status = loop {
        let status: Value = serde_json::from_str(&services.cli(&[
            "status",
            "--gateway",
            &gateway,
            "--output",
            "json",
        ])?)?;
        if status["worker_hosts"][0]["phase"] == "ready"
            && status["objectives"]
                .as_array()
                .is_some_and(|o| !o.is_empty())
        {
            break status;
        }
        ensure!(Instant::now() < deadline, "status never settled: {status}");
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(status["worker_hosts"][0]["id"], "local", "{status}");
    assert_eq!(status["tags"][0]["id"], "owner", "{status}");
    assert_eq!(status["objectives"][0]["id"], "ship-it", "{status}");
    assert_eq!(status["objectives"][0]["owner"], "owner", "{status}");
    assert_eq!(status["objectives"][0]["status"], "working", "{status}");
    let text = services.cli(&["status", "--gateway", &gateway])?;
    assert!(
        text.contains(
            "\nObjectives not finished\n  ship-it  working; owner owner; no budget; no deadline\n"
        ),
        "{text}"
    );
    // Without a Gateway token, status fails without echoing anything secret.
    let output = Command::new(BIN)
        .args(["status", "--gateway", &gateway])
        .env_clear()
        .output()?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("SUPERTAG_OPERATOR_TOKEN"));
    Ok(())
}

#[test]
fn sqlite_status_reads_hosts_tags_objectives_and_inbox() -> Result<()> {
    let temp = TempDir::new()?;
    exercise_status(&format!(
        "sqlite://{}?mode=rwc",
        temp.path().join("state.db").display()
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_status_reads_hosts_tags_objectives_and_inbox() -> Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("set SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let admin_url = fs::read_to_string(path)?;
    let options = PgConnectOptions::from_str(admin_url.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("supertag_rust_lifecycle_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    let result = tokio::task::spawn_blocking(move || exercise_status(&database)).await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("PostgreSQL status test panicked")?
}

#[test]
fn down_drains_running_work_and_leaves_services_running_until_forced() -> Result<()> {
    let mut machine = Machine::new()?;
    machine
        .extra
        .push(("SUPERTAG_TEST_DOWN_DRAIN_SECONDS".into(), "2".into()));
    let state = machine.state.to_str().unwrap().to_owned();
    machine.ok(&[
        "up",
        "--adapter",
        ADAPTER,
        "--adapter-arg=--wait-for-cancel",
    ])?;
    machine.ok(&[
        "tag",
        "put",
        "--state-directory",
        &state,
        "lead",
        "--instructions",
        "Lead.",
    ])?;
    let task: Value = serde_json::from_str(&machine.ok(&[
        "task",
        "submit",
        "--state-directory",
        &state,
        "--tag",
        "lead",
        "--session",
        "s1",
        "Wait.",
    ])?)?;
    let deadline = Instant::now() + WAIT;
    while service(&machine.ps()?, "local")?["attempts"] != 1 {
        ensure!(
            Instant::now() < deadline,
            "the Task Attempt never started: {task}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let running = pids(&machine.ps()?);

    // Down drains the host, waits its bound, then refuses and leaves everything running.
    let refused = machine.fails(&["down"])?;
    assert!(
        refused.contains("still run Task Attempts: local (1 Task Attempts)"),
        "{refused}"
    );
    assert!(refused.contains("supertag down --force"), "{refused}");
    let ps = machine.ps()?;
    assert_eq!(pids(&ps), running);
    assert_eq!(service(&ps, "local")?["draining"], true, "{ps}");

    // Ctrl-C while down waits stops waiting, not the command: everything stops.
    let mut down = machine
        .command(&["down"])
        .env("SUPERTAG_TEST_DOWN_DRAIN_SECONDS", "120")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = down.stdout.take().context("stdout")?;
    let (send, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = send.send(line);
        }
    });
    let waiting = lines.recv_timeout(WAIT)?;
    assert!(
        waiting.contains("Waiting for running Task Attempts") && waiting.contains("Ctrl-C"),
        "{waiting}"
    );
    unsafe {
        libc::kill(down.id() as i32, libc::SIGINT);
    }
    let output = down.wait_with_output()?;
    let text = lines.iter().collect::<Vec<_>>().join("\n");
    ensure!(
        output.status.success(),
        "interrupted down failed: {text}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(text.contains("Stopped waiting for local"), "{text}");
    assert!(text.contains("Stopped SuperTag"), "{text}");
    wait_gone(&running)?;
    // The next up returns the drained host to service, with --force passed through cleanly.
    machine.ok(&["up", "--adapter", ADAPTER, "--force"])?;
    assert_eq!(service(&machine.ps()?, "local")?["draining"], false);
    machine.ok(&["down", "--force"])?;
    Ok(())
}

/// A unit name shared by two state directories, one a prefix of the other, belongs to one.
#[cfg(target_os = "macos")]
#[test]
fn a_service_unit_belongs_to_exactly_one_state_directory() -> Result<()> {
    let mut machine = Machine::new()?;
    let launchd = fake_launchd(&mut machine)?;
    let config = json!({
        "services": {
            "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"], "restart": "unless-stopped"},
            "builder": {"type": "host", "adapter": ADAPTER, "restart": "unless-stopped"},
        },
    });
    // Both use the default name, so both want the unit ai.supertag.
    let dev = machine.home.join(".supertag-dev");
    let dev_arg = dev.to_str().unwrap().to_owned();
    state_with(&dev, &config)?;
    state_with(&machine.state, &config)?;
    let plist = machine.home.join("Library/LaunchAgents/ai.supertag.plist");
    machine.ok(&["up", "--state-directory", &dev_arg])?;
    let dev_ps: Value = serde_json::from_str(&machine.ok(&[
        "ps",
        "--state-directory",
        &dev_arg,
        "--output",
        "json",
    ])?)?;
    assert_eq!(dev_ps["supervisor"]["mode"], "service", "{dev_ps}");
    let running = pids(&dev_ps);

    // ~/.supertag is a prefix of ~/.supertag-dev, and still never claims its unit.
    let refused = machine.fails(&["up"])?;
    assert!(
        refused.contains("already runs SuperTag for") && refused.contains(".supertag-dev"),
        "{refused}"
    );
    // down for another state directory never stops or removes that unit.
    for args in [&["down"][..], &["down", "--remove-services"][..]] {
        let down = machine.ok(args)?;
        assert!(down.contains("left alone"), "{down}");
        assert!(down.contains("SuperTag is not running"), "{down}");
    }
    let empty = machine.home.join("empty");
    fs::create_dir_all(&empty)?;
    machine.ok(&["down", "--state-directory", empty.to_str().unwrap()])?;
    let calls = fs::read_to_string(launchd.join("calls"))?;
    assert!(!calls.contains("bootout"), "{calls}");
    assert!(plist.exists());
    assert!(running.iter().all(|pid| alive(*pid)));

    let down = machine.ok(&["down", "--remove-services", "--state-directory", &dev_arg])?;
    assert!(down.contains("Removed service unit"), "{down}");
    wait_gone(&running)?;
    assert!(!plist.exists());
    Ok(())
}

/// A service unit sees only its own environment and env_file, not this shell's.
#[cfg(target_os = "macos")]
#[test]
fn up_refuses_a_unit_that_cannot_load_the_file_and_warns_about_shell_variables() -> Result<()> {
    let mut machine = Machine::new()?;
    fake_launchd(&mut machine)?;
    machine
        .extra
        .push(("LIFECYCLE_ADAPTER".into(), ADAPTER.into()));
    state_with(
        &machine.state,
        &json!({
            "services": {
                "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"]},
                "builder": {"type": "host", "adapter": "${LIFECYCLE_ADAPTER}", "restart": "unless-stopped"},
            },
        }),
    )?;
    let plist = machine.home.join("Library/LaunchAgents/ai.supertag.plist");
    let refused = machine.fails(&["up"])?;
    assert!(
        refused.contains("${LIFECYCLE_ADAPTER} is not set") && refused.contains("env_file"),
        "{refused}"
    );
    assert!(
        !plist.exists(),
        "a unit that cannot load its file is never installed"
    );

    // From env_file the unit sees the same value as this shell: no warning.
    let env = machine.state.join(".env");
    fs::write(&env, format!("LIFECYCLE_ADAPTER={ADAPTER}\n"))?;
    fs::set_permissions(&env, fs::Permissions::from_mode(0o600))?;
    let up = machine.ok(&["up"])?;
    assert!(!up.contains("Warning"), "{up}");
    assert!(up.contains("under its service unit"), "{up}");

    // A different shell value is one the unit cannot see.
    let link = machine.bin.join("adapter-link");
    std::os::unix::fs::symlink(ADAPTER, &link)?;
    machine
        .extra
        .retain(|(name, _)| name != "LIFECYCLE_ADAPTER");
    machine
        .extra
        .push(("LIFECYCLE_ADAPTER".into(), link.to_str().unwrap().into()));
    // So is an HTTP proxy only this shell names.
    machine
        .extra
        .push(("HTTPS_PROXY".into(), "http://proxy.invalid:3128".into()));
    let again = machine.ok(&["up"])?;
    assert!(
        again.contains("Warning: the service unit")
            && again.contains("cannot see HTTPS_PROXY, LIFECYCLE_ADAPTER"),
        "{again}"
    );
    assert!(again.contains("left alone"), "{again}");
    let running = pids(&machine.ps()?);
    machine.ok(&["down", "--remove-services"])?;
    wait_gone(&running)?;
    Ok(())
}
