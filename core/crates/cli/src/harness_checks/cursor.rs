//! Cursor checks. The Cursor SDK runner authenticates only with CURSOR_API_KEY, so a key is
//! verified by listing models through the packaged Cursor bridge; without a key, the Cursor CLI
//! is asked only whether it is signed in, which is advice and never a working sign-in.
use std::{
    ffi::{OsStr, OsString},
    future::Future,
    path::Path,
};

use serde_json::Value;

use super::probe::{self, PROCESS_VARIABLES, Variables};

const SDK_ADVICE: &str = "Set CURSOR_API_KEY for the Worker Host.";
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_LISTING: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    SignedIn,
    NoModels,
    VerificationFailed,
    CliLoginOnly,
    LoggedOut,
    MissingCli,
    ProbeFailed,
}

#[derive(Debug)]
pub struct SignIn {
    pub status: Status,
    pub message: String,
}

fn result(status: Status, message: impl Into<String>) -> SignIn {
    SignIn {
        status,
        message: message.into(),
    }
}

/// The Cursor SDK's answer for configured models: the IDs it lists, or why it could not list.
#[derive(Debug, PartialEq, Eq)]
pub enum Listing {
    Available(Vec<String>),
    Failed(String),
}

/// List models through the Cursor bridge's `--check-models` mode, which runs the SDK's
/// `Cursor.models.list` with CURSOR_API_KEY. The bridge redacts the key from its messages.
pub async fn list_models(
    runtime: &Path,
    entry: &Path,
    models: &[String],
    key: &str,
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> Listing {
    let mut args: Vec<OsString> = vec![entry.into(), "--check-models".into()];
    for model in models {
        args.extend(["--check-model".into(), model.into()]);
    }
    let mut environment: Variables = variables
        .iter()
        .filter(|(name, _)| {
            PROCESS_VARIABLES
                .iter()
                .any(|known| OsStr::new(known) == *name)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    environment.insert("CURSOR_API_KEY".into(), key.into());
    let failed = || {
        Listing::Failed("Cursor model listing failed: the Cursor bridge did not answer. Check CURSOR_API_KEY in the host service environment.".into())
    };
    let Ok((status, stdout)) =
        probe::output(runtime, &args, &environment, None, None, MAX_LISTING, stop).await
    else {
        return failed();
    };
    let Ok(answer) = serde_json::from_slice::<Value>(&stdout) else {
        return failed();
    };
    let available = answer["availableIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    match (status.success(), answer["status"].as_str()) {
        (true, Some("ok")) => Listing::Available(available),
        (_, Some("failed")) => answer["message"]
            .as_str()
            .map(|message| Listing::Failed(message.replace(key, "[redacted]")))
            .unwrap_or_else(failed),
        _ => failed(),
    }
}

enum Run {
    Missing,
    Failed,
    Output(String),
}

/// Check Cursor sign-in as the Worker Host would use it. `verify` lists models for a key;
/// `stop` makes each CLI probe's stop condition.
pub async fn check_sign_in<F: Future<Output = ()>>(
    variables: &Variables,
    verify: impl AsyncFnOnce(&str) -> Listing,
    stop: impl Fn() -> F,
) -> SignIn {
    if let Some(key) = probe::text(variables, "CURSOR_API_KEY") {
        return match verify(&key).await {
            Listing::Available(models) if models.is_empty() => result(
                Status::NoModels,
                "Cursor SDK sign-in works, but no models are available.",
            ),
            Listing::Available(_) => result(
                Status::SignedIn,
                "Cursor SDK sign-in and model access verified.",
            ),
            Listing::Failed(_) => result(
                Status::VerificationFailed,
                "Could not verify Cursor SDK sign-in or model access.",
            ),
        };
    }
    // The CLI never sees CURSOR_API_KEY or any other credential.
    let environment: Variables = variables
        .iter()
        .filter(|(name, _)| {
            PROCESS_VARIABLES
                .iter()
                .any(|known| OsStr::new(known) == *name)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let run = async |command: &str, args: &[&str]| {
        let Some(program) = probe::find_on_path(
            command,
            environment.get(OsStr::new("PATH")).map(OsString::as_os_str),
        ) else {
            return Run::Missing;
        };
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        match probe::output(
            &program,
            &args,
            &environment,
            None,
            None,
            MAX_OUTPUT,
            stop(),
        )
        .await
        {
            Ok((status, stdout)) if status.success() => {
                Run::Output(String::from_utf8_lossy(&stdout).into_owned())
            }
            _ => Run::Failed,
        }
    };
    let mut command = "cursor-agent";
    match run(command, &["--version"]).await {
        Run::Output(_) => {}
        Run::Failed => {
            return result(
                Status::ProbeFailed,
                format!("Cursor CLI probe failed. {SDK_ADVICE}"),
            );
        }
        Run::Missing => {
            // Some installs name it `agent`; another CLI may use that name too.
            command = "agent";
            let identified = match run(command, &["about", "--format", "json"]).await {
                Run::Output(about) => identifies_cursor(&about),
                _ => false,
            };
            if !identified
                && !matches!(run(command, &["--version"]).await, Run::Output(version) if identifies_cursor(&version))
            {
                return result(
                    Status::MissingCli,
                    format!("Cursor CLI was not found. {SDK_ADVICE}"),
                );
            }
        }
    }
    let Run::Output(status) = run(command, &["status", "--format", "json"]).await else {
        // CLI output may contain account or credential data; only a fixed message leaves.
        return result(
            Status::ProbeFailed,
            format!("Could not check Cursor CLI sign-in. {SDK_ADVICE}"),
        );
    };
    match serde_json::from_str::<Value>(&status)
        .ok()
        .and_then(|value| value.get("isAuthenticated").and_then(Value::as_bool))
    {
        Some(true) => result(
            Status::CliLoginOnly,
            "Cursor CLI is signed in, but the Cursor SDK runner needs CURSOR_API_KEY.",
        ),
        Some(false) => result(
            Status::LoggedOut,
            format!("Cursor CLI is signed out. {SDK_ADVICE}"),
        ),
        None => result(
            Status::ProbeFailed,
            format!("Cursor CLI returned an invalid status. {SDK_ADVICE}"),
        ),
    }
}

/// Whether CLI output names Cursor, as JSON `name`, `product`, `application` or `cli`, or as text.
fn identifies_cursor(output: &str) -> bool {
    match serde_json::from_str::<Value>(output) {
        Ok(Value::Object(about)) => ["name", "product", "application", "cli"]
            .iter()
            .any(|field| {
                about
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(cursor_name)
            }),
        Ok(_) => false,
        Err(_) => cursor_name(output),
    }
}

/// `cursor`, `cursor-agent` or `Cursor Agent` as a whole leading word.
fn cursor_name(value: &str) -> bool {
    let value = value.trim();
    value
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cursor"))
        && !value[6..]
            .chars()
            .next()
            .is_some_and(|next| next.is_alphanumeric() || next == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_checks::probe::tests::{exists, gone, script};
    use std::path::PathBuf;

    fn variables(directory: &Path, extra: &[(&str, &str)]) -> Variables {
        let mut variables = Variables::from([
            ("PATH".into(), directory.as_os_str().to_owned()),
            ("HOME".into(), directory.as_os_str().to_owned()),
        ]);
        for (name, value) in extra {
            variables.insert(name.into(), value.into());
        }
        variables
    }

    /// Fake CLIs that log each call and fail if they ever see CURSOR_API_KEY.
    fn cli(directory: &Path, name: &str, answers: &[(&str, &str)]) -> PathBuf {
        let mut body = format!(
            "test -z \"$CURSOR_API_KEY\" || exit 7\necho \"{name} $*\" >> '{}/calls'\ncase \"$*\" in\n",
            directory.display()
        );
        for (args, output) in answers {
            body.push_str(&format!("  '{args}') printf '%s' '{output}';;\n"));
        }
        body.push_str("  *) exit 1;;\nesac");
        script(directory, name, &body)
    }

    fn calls(directory: &Path) -> Vec<String> {
        std::fs::read_to_string(directory.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    async fn check(variables: &Variables) -> SignIn {
        check_sign_in(
            variables,
            async |_| panic!("no key, so no SDK listing"),
            std::future::pending::<()>,
        )
        .await
    }

    #[tokio::test]
    async fn a_key_is_verified_by_listing_models_and_never_starts_the_cli() {
        let temporary = tempfile::tempdir().unwrap();
        cli(temporary.path(), "cursor-agent", &[]);
        for (listing, status) in [
            (Listing::Available(vec!["auto".into()]), Status::SignedIn),
            (Listing::Available(vec![]), Status::NoModels),
            (
                Listing::Failed("secret-token rejected".into()),
                Status::VerificationFailed,
            ),
        ] {
            let checked = check_sign_in(
                &variables(temporary.path(), &[("CURSOR_API_KEY", "secret-token")]),
                async |key| {
                    assert_eq!(key, "secret-token");
                    listing
                },
                std::future::pending::<()>,
            )
            .await;
            assert_eq!(checked.status, status);
            assert!(!checked.message.contains("secret-token"));
        }
        assert!(calls(temporary.path()).is_empty());
    }

    #[tokio::test]
    async fn a_signed_in_cli_is_only_advice() {
        let temporary = tempfile::tempdir().unwrap();
        cli(
            temporary.path(),
            "cursor-agent",
            &[
                ("--version", "cursor-agent 1.0"),
                (
                    "status --format json",
                    r#"{"status":"ok","isAuthenticated":true}"#,
                ),
            ],
        );
        let checked = check(&variables(temporary.path(), &[])).await;
        assert_eq!(checked.status, Status::CliLoginOnly);
        assert!(checked.message.contains("CURSOR_API_KEY"));
        assert_eq!(
            calls(temporary.path()),
            [
                "cursor-agent --version",
                "cursor-agent status --format json"
            ]
        );
    }

    #[tokio::test]
    async fn logged_out_malformed_and_missing_clis_are_distinct() {
        let temporary = tempfile::tempdir().unwrap();
        let variables = variables(temporary.path(), &[]);
        assert_eq!(check(&variables).await.status, Status::MissingCli);
        cli(
            temporary.path(),
            "cursor-agent",
            &[
                ("--version", "cursor-agent 1.0"),
                (
                    "status --format json",
                    r#"{"status":"logged_out","isAuthenticated":false}"#,
                ),
            ],
        );
        assert_eq!(check(&variables).await.status, Status::LoggedOut);
        cli(
            temporary.path(),
            "cursor-agent",
            &[
                ("--version", "cursor-agent 1.0"),
                ("status --format json", "secret-token {not-json"),
            ],
        );
        let checked = check(&variables).await;
        assert_eq!(checked.status, Status::ProbeFailed);
        assert!(!checked.message.contains("secret-token"));
    }

    #[tokio::test]
    async fn an_agent_alias_counts_only_when_it_identifies_as_cursor() {
        let temporary = tempfile::tempdir().unwrap();
        let variables = variables(temporary.path(), &[]);
        cli(
            temporary.path(),
            "agent",
            &[
                (
                    "about --format json",
                    r#"{"name":"Grok CLI","message":"Cursor is elsewhere"}"#,
                ),
                ("--version", "Grok CLI 1.0"),
            ],
        );
        assert_eq!(check(&variables).await.status, Status::MissingCli);
        assert!(!calls(temporary.path()).contains(&"agent status --format json".to_owned()));
        cli(
            temporary.path(),
            "agent",
            &[
                ("--version", "Cursor Agent 2026.05.28"),
                ("status --format json", r#"{"isAuthenticated":false}"#),
            ],
        );
        assert_eq!(check(&variables).await.status, Status::LoggedOut);
        cli(
            temporary.path(),
            "agent",
            &[
                ("about --format json", r#"{"name":"Cursor Agent"}"#),
                ("status --format json", r#"{"isAuthenticated":true}"#),
            ],
        );
        assert_eq!(check(&variables).await.status, Status::CliLoginOnly);
    }

    #[tokio::test]
    async fn a_hanging_cli_probe_is_killed() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("started");
        script(
            temporary.path(),
            "cursor-agent",
            &format!(
                "echo $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let mut variables = variables(temporary.path(), &[]);
        variables.insert(
            "PATH".into(),
            format!("{}:/bin:/usr/bin", temporary.path().display()).into(),
        );
        let checked = check_sign_in(
            &variables,
            async |_| unreachable!(),
            || exists(started.clone()),
        )
        .await;
        assert_eq!(checked.status, Status::ProbeFailed);
        assert!(gone(&started));
    }

    #[tokio::test]
    async fn the_bridge_listing_passes_only_the_key_and_redacts_it() {
        let temporary = tempfile::tempdir().unwrap();
        let entry = temporary.path().join("entry.js");
        let runtime = script(
            temporary.path(),
            "node",
            &format!(
                "test \"$1\" = '{}' && test \"$2\" = --check-models || exit 9\n\
                 test -z \"$UNRELATED_SECRET\" || exit 8\n\
                 if [ \"$4\" = unknown ]; then printf '%s' '{{\"status\":\"failed\",\"message\":\"Unknown Cursor model unknown; available: auto\",\"availableIds\":[\"auto\"]}}'; \
                 elif [ \"$CURSOR_API_KEY\" = bad ]; then printf '%s' '{{\"status\":\"failed\",\"message\":\"Cursor rejected CURSOR_API_KEY; replace the key: bad\",\"availableIds\":[]}}'; \
                 else printf '%s' '{{\"status\":\"ok\",\"availableIds\":[\"auto\",\"composer-2.5\"]}}'; fi",
                entry.display()
            ),
        );
        let variables = Variables::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("UNRELATED_SECRET".into(), "never".into()),
        ]);
        assert_eq!(
            list_models(
                &runtime,
                &entry,
                &["composer-2.5".into()],
                "good",
                &variables,
                std::future::pending()
            )
            .await,
            Listing::Available(vec!["auto".into(), "composer-2.5".into()])
        );
        assert_eq!(
            list_models(
                &runtime,
                &entry,
                &["unknown".into()],
                "good",
                &variables,
                std::future::pending()
            )
            .await,
            Listing::Failed("Unknown Cursor model unknown; available: auto".into())
        );
        let Listing::Failed(message) = list_models(
            &runtime,
            &entry,
            &[],
            "bad",
            &variables,
            std::future::pending(),
        )
        .await
        else {
            panic!("a rejected key fails");
        };
        assert!(
            message.starts_with("Cursor rejected CURSOR_API_KEY"),
            "{message}"
        );
        assert!(!message.ends_with(": bad"), "{message}");
    }
}
