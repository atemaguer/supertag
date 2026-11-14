//! Per-user service units for the local supervisor: launchd on macOS, systemd on Linux.
//!
//! `launchctl` and `systemctl` are resolved on PATH, as the TypeScript CLI did, so a test can
//! substitute a recording fake without touching the real user session.
use std::{
    fs::{self, DirBuilder},
    os::unix::fs::DirBuilderExt as _,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail, ensure};

use crate::lifecycle::DEFAULT_INSTANCE;

/// launchd label `ai.supertag`, or systemd unit `supertag.service`; a supertag.yaml `name` other
/// than the default is appended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitName {
    pub label: String,
    pub unit: String,
}

impl UnitName {
    pub fn new(instance: &str) -> Self {
        if instance == DEFAULT_INSTANCE {
            Self {
                label: "ai.supertag".into(),
                unit: "supertag.service".into(),
            }
        } else {
            Self {
                label: format!("ai.supertag.{instance}"),
                unit: format!("supertag-{instance}.service"),
            }
        }
    }
}

/// What a per-user service unit runs: the supervisor in the foreground of the unit.
pub struct ServiceDefinition {
    pub name: UnitName,
    pub description: String,
    pub working_directory: String,
    pub command: Vec<String>,
    pub log_file: String,
    pub environment: Vec<(String, String)>,
    /// The state directory the unit serves, so two directories never share one unit.
    pub state: String,
}

pub enum ServiceManager {
    Launchd { home: PathBuf, uid: u32 },
    Systemd { config: PathBuf },
}

impl ServiceManager {
    pub fn for_platform() -> Result<Self> {
        let home =
            PathBuf::from(std::env::var_os("HOME").context("HOME is required for a service unit")?);
        // SAFETY: getuid returns the calling process's real user ID.
        let uid = unsafe { libc::getuid() };
        if cfg!(target_os = "macos") {
            Ok(Self::Launchd { home, uid })
        } else if cfg!(target_os = "linux") {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map_or_else(|| home.join(".config"), PathBuf::from);
            Ok(Self::Systemd { config })
        } else {
            bail!(
                "running SuperTag as a service is not supported on this platform; remove restart: unless-stopped from supertag.yaml"
            )
        }
    }

    pub fn path(&self, name: &UnitName) -> PathBuf {
        match self {
            Self::Launchd { home, .. } => home
                .join("Library/LaunchAgents")
                .join(format!("{}.plist", name.label)),
            Self::Systemd { config } => config.join("systemd/user").join(&name.unit),
        }
    }

    fn render(&self, definition: &ServiceDefinition) -> String {
        match self {
            Self::Launchd { .. } => launchd_plist(definition),
            Self::Systemd { .. } => systemd_unit(definition),
        }
    }

    pub fn installed(&self, name: &UnitName) -> bool {
        fs::symlink_metadata(self.path(name)).is_ok_and(|metadata| metadata.is_file())
    }

    /// Whether the installed unit is exactly this definition.
    pub fn current(&self, definition: &ServiceDefinition) -> Result<bool> {
        Ok(fs::read_to_string(self.path(&definition.name))
            .is_ok_and(|text| text == self.render(definition)))
    }

    /// The other state directory an installed unit of this name serves, if any.
    pub fn other_state(&self, definition: &ServiceDefinition) -> Result<Option<String>> {
        let Ok(text) = fs::read_to_string(self.path(&definition.name)) else {
            return Ok(None);
        };
        Ok(match marked_state(&text) {
            Some(marked) if marked == encode_state(&definition.state) => None,
            Some(marked) => Some(marked),
            None => Some("another state directory".into()),
        })
    }

    /// Whether the installed unit of this name serves exactly this state directory.
    pub fn serves(&self, name: &UnitName, state: &str) -> bool {
        fs::read_to_string(self.path(name))
            .ok()
            .and_then(|text| marked_state(&text))
            .is_some_and(|marked| marked == encode_state(state))
    }

    pub fn loaded(&self, name: &UnitName) -> bool {
        match self {
            Self::Launchd { uid, .. } => run(
                "launchctl",
                &["print", &format!("gui/{uid}/{}", name.label)],
            )
            .is_ok(),
            Self::Systemd { .. } => {
                run("systemctl", &["--user", "is-active", "--quiet", &name.unit]).is_ok()
            }
        }
    }

    /// Write the definition, enable it at login, and start it now.
    pub fn install(&self, definition: &ServiceDefinition) -> Result<Vec<String>> {
        let path = self.path(&definition.name);
        let parent = path.parent().context("service unit directory")?;
        DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(parent)?;
        match self {
            Self::Launchd { uid, .. } => {
                if self.loaded(&definition.name) {
                    run(
                        "launchctl",
                        &["bootout", &format!("gui/{uid}/{}", definition.name.label)],
                    )?;
                }
                write(&path, &self.render(definition))?;
                run(
                    "launchctl",
                    &["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()],
                )?;
                Ok(vec![format!(
                    "Installed {}; it starts SuperTag when you log in.",
                    path.display()
                )])
            }
            Self::Systemd { .. } => {
                write(&path, &self.render(definition))?;
                run("systemctl", &["--user", "daemon-reload"])?;
                run("systemctl", &["--user", "enable", &definition.name.unit])?;
                run("systemctl", &["--user", "restart", &definition.name.unit])?;
                Ok(vec![
                    format!("Installed {}; it starts SuperTag when you log in.", path.display()),
                    "To keep it running while you are logged out and after a reboot, enable lingering once: loginctl enable-linger $USER".into(),
                ])
            }
        }
    }

    /// Stop the unit until the next login. Its definition stays installed.
    pub fn stop(&self, name: &UnitName) -> Result<()> {
        match self {
            Self::Launchd { uid, .. } => {
                if self.loaded(name) {
                    run(
                        "launchctl",
                        &["bootout", &format!("gui/{uid}/{}", name.label)],
                    )?;
                }
                Ok(())
            }
            Self::Systemd { .. } => run("systemctl", &["--user", "stop", &name.unit]),
        }
    }

    /// Stop the unit and remove its definition.
    pub fn uninstall(&self, name: &UnitName) -> Result<()> {
        let path = self.path(name);
        match self {
            Self::Launchd { .. } => {
                self.stop(name)?;
                remove(&path)
            }
            Self::Systemd { .. } => {
                let _ = run("systemctl", &["--user", "disable", "--now", &name.unit]);
                remove(&path)?;
                run("systemctl", &["--user", "daemon-reload"])
            }
        }
    }
}

fn write(path: &Path, text: &str) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&temporary, text)?;
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })?;
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("run {program}"))?;
    ensure!(
        output.status.success(),
        "{program} {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&[output.stdout, output.stderr].concat()).trim()
    );
    Ok(())
}

const MARKER: &str = "supertag-state: ";

/// A state path as its marker carries it: `--` cannot appear inside an XML comment.
fn encode_state(state: &str) -> String {
    state.replace("--", "-\u{2010}")
}

fn state_marker(state: &str) -> String {
    format!("{MARKER}{}", encode_state(state))
}

/// The whole state path in a unit's marker line, so `/a/.supertag` never matches a unit for
/// `/a/.supertag-dev`.
fn marked_state(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("# ") {
            return rest.strip_prefix(MARKER).map(str::to_owned);
        }
        line.strip_prefix("<!-- ")
            .and_then(|rest| rest.strip_suffix(" -->"))
            .and_then(|rest| rest.strip_prefix(MARKER))
            .map(|value| {
                value
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&amp;", "&")
            })
    })
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn launchd_plist(definition: &ServiceDefinition) -> String {
    let strings = |values: &[String]| {
        values
            .iter()
            .map(|value| format!("    <string>{}</string>\n", xml(value)))
            .collect::<String>()
    };
    let environment = definition
        .environment
        .iter()
        .map(|(key, value)| {
            format!(
                "    <key>{}</key>\n    <string>{}</string>\n",
                xml(key),
                xml(value)
            )
        })
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- {marker} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>WorkingDirectory</key>
  <string>{directory}</string>
  <key>EnvironmentVariables</key>
  <dict>
{environment}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ExitTimeOut</key>
  <integer>90</integer>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        marker = xml(&state_marker(&definition.state)),
        label = xml(&definition.name.label),
        arguments = strings(&definition.command),
        directory = xml(&definition.working_directory),
        log = xml(&definition.log_file),
    )
}

fn systemd_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte))
    {
        value.to_owned()
    } else {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
                .replace('$', "$$")
        )
    }
}

pub fn systemd_unit(definition: &ServiceDefinition) -> String {
    let environment = definition
        .environment
        .iter()
        .map(|(key, value)| format!("Environment={}\n", systemd_quote(&format!("{key}={value}"))))
        .collect::<String>();
    format!(
        "# {marker}\n[Unit]\nDescription={description}\n\n[Service]\nType=simple\nWorkingDirectory={directory}\nExecStart={command}\n{environment}Restart=on-failure\nRestartSec=5\nTimeoutStopSec=90\nKillMode=mixed\nStandardOutput=append:{log}\nStandardError=append:{log}\n\n[Install]\nWantedBy=default.target\n",
        marker = state_marker(&definition.state),
        description = definition.description.replace('\n', " "),
        directory = systemd_quote(&definition.working_directory),
        command = definition
            .command
            .iter()
            .map(|arg| systemd_quote(arg))
            .collect::<Vec<_>>()
            .join(" "),
        log = definition.log_file,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> ServiceDefinition {
        ServiceDefinition {
            name: UnitName::new("work"),
            description: "SuperTag services for /home/me/.supertag".into(),
            working_directory: "/home/me/.supertag".into(),
            command: vec![
                "/opt/supertag/bin/supertag".into(),
                "up".into(),
                "--foreground".into(),
                "--file".into(),
                "/home/me/my config/supertag.yaml".into(),
            ],
            log_file: "/home/me/.supertag/logs/supervisor.log".into(),
            environment: vec![
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("SUPERTAG_SUPERVISOR_MODE".into(), "service".into()),
            ],
            state: "/home/me/.supertag".into(),
        }
    }

    #[test]
    fn unit_names_follow_the_instance_name() {
        assert_eq!(UnitName::new("supertag").label, "ai.supertag");
        assert_eq!(UnitName::new("supertag").unit, "supertag.service");
        assert_eq!(UnitName::new("work").label, "ai.supertag.work");
        assert_eq!(UnitName::new("work").unit, "supertag-work.service");
    }

    #[test]
    fn systemd_unit_quotes_arguments_and_restarts_only_on_failure() {
        let unit = systemd_unit(&definition());
        assert!(unit.contains(
            "ExecStart=/opt/supertag/bin/supertag up --foreground --file \"/home/me/my config/supertag.yaml\"\n"
        ), "{unit}");
        assert!(unit.contains("Environment=SUPERTAG_SUPERVISOR_MODE=service\n"));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("StandardOutput=append:/home/me/.supertag/logs/supervisor.log\n"));
        assert!(unit.contains("WantedBy=default.target\n"));
        assert!(unit.starts_with("# supertag-state: /home/me/.supertag\n"));
    }

    #[test]
    fn launchd_plist_keeps_failed_supervisors_alive_and_escapes_xml() {
        let mut definition = definition();
        definition.command.push("a<b&c".into());
        let plist = launchd_plist(&definition);
        assert!(plist.contains("<string>ai.supertag.work</string>"));
        assert!(plist.contains("<string>a&lt;b&amp;c</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(plist.contains("<key>ExitTimeOut</key>\n  <integer>90</integer>"));
    }

    #[test]
    fn a_unit_serving_another_state_directory_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ServiceManager::Systemd {
            config: temp.path().to_owned(),
        };
        let mine = definition();
        assert_eq!(manager.other_state(&mine).unwrap(), None);
        let mut other = definition();
        other.state = "/home/me/other".into();
        let path = manager.path(&mine.name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, systemd_unit(&other)).unwrap();
        assert_eq!(
            manager.other_state(&mine).unwrap().as_deref(),
            Some("/home/me/other")
        );
        fs::write(&path, systemd_unit(&mine)).unwrap();
        assert_eq!(manager.other_state(&mine).unwrap(), None);
        assert!(manager.current(&mine).unwrap());
        assert!(manager.serves(&mine.name, &mine.state));
        assert!(!manager.serves(&mine.name, "/home/me/other"));
    }

    #[test]
    fn a_state_directory_never_claims_a_unit_for_a_longer_path() {
        let temp = tempfile::tempdir().unwrap();
        for manager in [
            ServiceManager::Systemd {
                config: temp.path().join("systemd"),
            },
            ServiceManager::Launchd {
                home: temp.path().join("launchd"),
                uid: 0,
            },
        ] {
            let mut dev = definition();
            dev.state = "/home/me/.supertag-dev".into();
            let mine = definition();
            let path = manager.path(&mine.name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, manager.render(&dev)).unwrap();
            assert_eq!(
                manager.other_state(&mine).unwrap().as_deref(),
                Some("/home/me/.supertag-dev")
            );
            assert!(!manager.serves(&mine.name, &mine.state));
            assert!(manager.serves(&dev.name, &dev.state));
            // A path with `--` and XML characters round-trips through the marker.
            let mut odd = definition();
            odd.state = "/home/me/a--b&<c>".into();
            fs::write(&path, manager.render(&odd)).unwrap();
            assert!(manager.serves(&odd.name, &odd.state));
            assert_eq!(manager.other_state(&odd).unwrap(), None);
        }
    }
}
