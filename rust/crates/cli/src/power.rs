//! Laptop power facts that can stop Task Attempts, for the `supertag ps` warning.
use std::{path::Path, time::Duration};

/// Power facts about a laptop. `None` wherever this is used means the machine is not a laptop
/// or the facts are unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaptopPower {
    /// The laptop runs on its battery, so it can run down or sleep on low power.
    pub on_battery: bool,
    /// Closing the lid sleeps the laptop; keeping it awake does not prevent that.
    pub lid_sleep: bool,
}

/// Reads `pmset -g batt` and `pmset -g` output from macOS. A Mac without an internal battery is
/// not a laptop. Closing the lid sleeps a laptop unless sleep is disabled (`pmset disablesleep 1`).
pub fn parse_darwin(battery: &str, settings: &str) -> Option<LaptopPower> {
    if !battery.contains("InternalBattery") {
        return None;
    }
    let sleep_disabled = settings.lines().any(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some("SleepDisabled") && words.next() == Some("1")
    });
    Some(LaptopPower {
        on_battery: battery.contains("drawing from 'Battery Power'"),
        lid_sleep: !sleep_disabled,
    })
}

/// One entry of `/sys/class/power_supply`: its `type` and, for mains, `online`.
pub struct LinuxSupply {
    pub kind: String,
    pub online: Option<String>,
}

/// Reads Linux power supplies and logind.conf. A machine without a battery is not a laptop.
/// Closing the lid suspends by default; `HandleLidSwitch` (or `HandleLidSwitchExternalPower` on
/// mains power) set to `ignore` or `lock` prevents that.
pub fn parse_linux(supplies: &[LinuxSupply], logind: &str) -> Option<LaptopPower> {
    if !supplies
        .iter()
        .any(|supply| supply.kind.trim() == "Battery")
    {
        return None;
    }
    let on_battery = !supplies.iter().any(|supply| {
        supply.kind.trim() == "Mains" && supply.online.as_deref().map(str::trim) == Some("1")
    });
    let setting = |key: &str| {
        logind
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once('=')?;
                (name.trim() == key)
                    .then(|| value.split_whitespace().next())
                    .flatten()
            })
            .last()
    };
    let action = (!on_battery)
        .then(|| setting("HandleLidSwitchExternalPower"))
        .flatten()
        .or_else(|| setting("HandleLidSwitch"))
        .unwrap_or("suspend");
    Some(LaptopPower {
        on_battery,
        lid_sleep: action != "ignore" && action != "lock",
    })
}

/// The `supertag ps` warning for a laptop running Task Attempts, or `None` when none applies.
pub fn warning(power: Option<LaptopPower>) -> Option<String> {
    let power = power?;
    let risks: Vec<&str> = [
        power.on_battery.then_some("the laptop is on battery power"),
        power.lid_sleep.then_some("closing the lid will sleep it"),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!risks.is_empty()).then(|| {
        format!(
            "warning: Task Attempts are running, but {}. A long sleep can fail them; plug in and keep the lid open.",
            risks.join(" and ")
        )
    })
}

/// This machine's laptop power facts. Every failure reads as "not a laptop".
pub async fn read() -> Option<LaptopPower> {
    if cfg!(target_os = "macos") {
        let battery = run("/usr/bin/pmset", &["-g", "batt"]).await?;
        let settings = run("/usr/bin/pmset", &["-g"]).await?;
        parse_darwin(&battery, &settings)
    } else if cfg!(target_os = "linux") {
        let root = Path::new("/sys/class/power_supply");
        let mut supplies = Vec::new();
        for entry in std::fs::read_dir(root).ok()?.flatten().take(64) {
            let read = |name: &str| std::fs::read_to_string(entry.path().join(name)).ok();
            supplies.push(LinuxSupply {
                kind: read("type").unwrap_or_default(),
                online: read("online"),
            });
        }
        let logind = std::fs::read_to_string("/etc/systemd/logind.conf").unwrap_or_default();
        parse_linux(&supplies, &logind)
    } else {
        None
    }
}

async fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac_battery(source: &str) -> String {
        format!(
            "Now drawing from '{source}'\n -InternalBattery-0 (id=35848291)\t80%; discharging; 3:10 remaining present: true\n"
        )
    }

    #[test]
    fn reads_macos_battery_and_lid_sleep_from_pmset() {
        assert_eq!(
            parse_darwin(&mac_battery("Battery Power"), " sleep 1\n"),
            Some(LaptopPower {
                on_battery: true,
                lid_sleep: true
            })
        );
        assert_eq!(
            parse_darwin(&mac_battery("AC Power"), " SleepDisabled\t\t1\n sleep 0\n"),
            Some(LaptopPower {
                on_battery: false,
                lid_sleep: false
            })
        );
        // A desktop Mac has no internal battery.
        assert_eq!(parse_darwin("Now drawing from 'AC Power'\n", ""), None);
    }

    #[test]
    fn reads_linux_power_supplies_and_logind_lid_settings() {
        let supply = |kind: &str, online: Option<&str>| LinuxSupply {
            kind: kind.into(),
            online: online.map(Into::into),
        };
        assert_eq!(
            parse_linux(
                &[supply("Battery\n", None), supply("Mains", Some("0\n"))],
                ""
            ),
            Some(LaptopPower {
                on_battery: true,
                lid_sleep: true
            })
        );
        assert_eq!(
            parse_linux(
                &[supply("Battery\n", None), supply("Mains", Some("1\n"))],
                "[Login]\nHandleLidSwitch=suspend\nHandleLidSwitchExternalPower=ignore\n"
            ),
            Some(LaptopPower {
                on_battery: false,
                lid_sleep: false
            })
        );
        assert_eq!(
            parse_linux(&[supply("Battery\n", None)], "HandleLidSwitch=lock\n"),
            Some(LaptopPower {
                on_battery: true,
                lid_sleep: false
            })
        );
        assert_eq!(parse_linux(&[supply("Mains", Some("1"))], ""), None);
    }

    #[test]
    fn names_each_risk_and_stays_quiet_when_there_is_none() {
        assert_eq!(
            warning(Some(LaptopPower {
                on_battery: true,
                lid_sleep: true
            }))
            .as_deref(),
            Some(
                "warning: Task Attempts are running, but the laptop is on battery power and closing the lid will sleep it. A long sleep can fail them; plug in and keep the lid open."
            )
        );
        assert!(
            warning(Some(LaptopPower {
                on_battery: false,
                lid_sleep: true
            }))
            .unwrap()
            .contains("but closing the lid will sleep it.")
        );
        assert_eq!(
            warning(Some(LaptopPower {
                on_battery: false,
                lid_sleep: false
            })),
            None
        );
        assert_eq!(warning(None), None);
    }
}
