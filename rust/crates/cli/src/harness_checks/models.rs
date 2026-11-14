//! Startup checks that need no prompt: the installed Codex CLI's version, and each harness's
//! model listing compared with the models a host service configures.
use std::{ffi::OsString, future::Future, path::Path};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use super::probe::{self, Probe, Variables};

/// The result of checking one harness's configured models.
#[derive(Debug, PartialEq, Eq)]
pub enum ModelCheck {
    Ok,
    /// The provider does not offer a configured model: the host does not start.
    Failed(String),
    /// The check could not decide; the host starts and logs this note.
    Skipped(String),
}

/// A CLI that a harness runs from this machine's PATH and the oldest version SuperTag supports.
pub struct Requirement {
    pub name: &'static str,
    pub command: &'static str,
    pub minimum: &'static str,
    pub install: &'static str,
}

/// The Codex CLI the Rust Codex adapter runs.
pub const CODEX: Requirement = Requirement {
    name: "Codex",
    command: "codex",
    minimum: supertag_codex_adapter::MINIMUM_CODEX_VERSION,
    install: "Install or upgrade it with: npm install -g @openai/codex",
};

const MAX_VERSION_OUTPUT: usize = 64 * 1024;
const MAX_MESSAGE: usize = 1024 * 1024;
const MAX_PAGES: usize = 64;

/// Find the CLI on `variables`' PATH and check `--version` against its minimum. Returns why the
/// host cannot use it, or None.
pub async fn check_cli(
    requirement: &Requirement,
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> Option<String> {
    let Some(path) = probe::find_on_path(
        requirement.command,
        variables
            .get(std::ffi::OsStr::new("PATH"))
            .map(OsString::as_os_str),
    ) else {
        return Some(format!(
            "{} is not installed: `{}` is not on PATH. {}",
            requirement.name, requirement.command, requirement.install
        ));
    };
    let unknown = || {
        format!(
            "{} at {} did not report a version with `{} --version`. {}",
            requirement.name,
            path.display(),
            requirement.command,
            requirement.install
        )
    };
    let version = match probe::output(
        &path,
        &["--version".into()],
        variables,
        None,
        None,
        MAX_VERSION_OUTPUT,
        stop,
    )
    .await
    {
        Ok((status, stdout)) if status.success() => {
            first_version(&String::from_utf8_lossy(&stdout))
        }
        _ => None,
    };
    let Some(version) = version else {
        return Some(unknown());
    };
    (compare_versions(&version, requirement.minimum) == std::cmp::Ordering::Less).then(|| {
        format!(
            "{} {version} is older than {}, the oldest version SuperTag supports. {}",
            requirement.name, requirement.minimum, requirement.install
        )
    })
}

/// The first major.minor.patch in `text`, such as 0.163.0 from "codex-cli 0.163.0".
pub fn first_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digits = |mut index: usize| {
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        (index > start).then_some(index)
    };
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() || (start > 0 && bytes[start - 1].is_ascii_digit()) {
            continue;
        }
        let Some(first) = digits(start) else { continue };
        if bytes.get(first) != Some(&b'.') {
            continue;
        }
        let Some(second) = digits(first + 1) else {
            continue;
        };
        if bytes.get(second) != Some(&b'.') {
            continue;
        }
        if let Some(third) = digits(second + 1) {
            return Some(text[start..third].to_owned());
        }
    }
    None
}

/// Numeric major.minor.patch comparison; a missing part counts as 0.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (left, right) = (parts(left), parts(right));
    for index in 0..left.len().max(right.len()) {
        let ordering = left
            .get(index)
            .unwrap_or(&0)
            .cmp(right.get(index).unwrap_or(&0));
        if ordering.is_ne() {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare configured models with the models a harness lists for this account.
pub fn compare_models(harness: &str, configured: &[String], available: &[String]) -> ModelCheck {
    if available.is_empty() {
        return ModelCheck::Skipped(format!(
            "{harness} listed no models; skipping the model check."
        ));
    }
    let missing: Vec<_> = configured
        .iter()
        .filter(|model| !available.contains(model))
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        ModelCheck::Ok
    } else {
        ModelCheck::Failed(format!(
            "{harness} does not offer {} for this account. Available models: {}.",
            missing.join(", "),
            available.join(", ")
        ))
    }
}

/// Ask a Codex app server which models this account may use (`model/list`), without a prompt.
pub async fn list_codex_models(
    executable: &Path,
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> Result<Vec<String>> {
    let probe = Probe::start(
        executable,
        &["app-server".into(), "--listen".into(), "stdio://".into()],
        variables,
        None,
    )?;
    probe::bounded(probe, stop, async |probe| {
        probe
            .send(&json!({"id": 1, "method": "initialize",
                "params": {"clientInfo": {"name": "supertag", "version": "1"}}}))
            .await?;
        let mut models = Vec::new();
        let mut pages = 0;
        loop {
            let Some(message) = probe.object(MAX_MESSAGE).await? else {
                bail!("Codex app-server exited before listing models");
            };
            match message.get("id").and_then(Value::as_u64) {
                Some(1) => {
                    if message.get("error").is_some() {
                        bail!("Codex app-server refused initialization");
                    }
                    probe
                        .send(&json!({"method": "initialized", "params": {}}))
                        .await?;
                    probe
                        .send(&json!({"id": 2, "method": "model/list", "params": {}}))
                        .await?;
                }
                Some(2) => {
                    let data = message
                        .get("result")
                        .and_then(|result| result.get("data"))
                        .and_then(Value::as_array)
                        .filter(|_| message.get("error").is_none())
                        .context("Codex app-server did not list models")?;
                    for entry in data {
                        for key in ["id", "model"] {
                            if let Some(model) = entry.get(key).and_then(Value::as_str)
                                && !models.iter().any(|known| known == model)
                            {
                                models.push(model.to_owned());
                            }
                        }
                    }
                    pages += 1;
                    match message["result"].get("nextCursor").and_then(Value::as_str) {
                        Some(cursor) if !cursor.is_empty() && pages < MAX_PAGES => {
                            probe
                                .send(&json!({"id": 2, "method": "model/list",
                                    "params": {"cursor": cursor}}))
                                .await?;
                        }
                        _ => return Ok(models),
                    }
                }
                _ => {}
            }
        }
    })
    .await
}

/// Check configured Codex models with one listing; a listing failure skips the check.
pub async fn check_codex_models(
    models: &[String],
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> ModelCheck {
    if models.is_empty() {
        return ModelCheck::Ok;
    }
    let listed = match probe::find_on_path(
        CODEX.command,
        variables
            .get(std::ffi::OsStr::new("PATH"))
            .map(OsString::as_os_str),
    ) {
        Some(executable) => list_codex_models(&executable, variables, stop).await,
        None => Err(anyhow::anyhow!("`codex` is not on PATH")),
    };
    match listed {
        Ok(available) => compare_models("Codex", models, &available),
        Err(error) => ModelCheck::Skipped(format!(
            "Could not list Codex models ({error}); skipping the model check."
        )),
    }
}

/// Ask Claude Code for its model listing with the stream-json `initialize` control request that
/// the Agent SDK's `supportedModels()` uses. No prompt is sent.
pub async fn list_claude_models(
    executable: &Path,
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> Result<Vec<String>> {
    let probe = Probe::start(
        executable,
        &[
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--max-turns".into(),
            "1".into(),
            "--setting-sources=".into(),
        ],
        variables,
        None,
    )?;
    probe::bounded(probe, stop, async |probe| {
        probe
            .send(
                &json!({"request_id": "supertag-models", "type": "control_request",
                "request": {"subtype": "initialize"}}),
            )
            .await?;
        loop {
            let Some(message) = probe.object(MAX_MESSAGE).await? else {
                bail!("Claude Code exited before listing models");
            };
            let response = &message["response"];
            if message["type"] != "control_response" || response["request_id"] != "supertag-models"
            {
                continue;
            }
            if response["subtype"] != "success" {
                bail!("Claude Code refused the model listing");
            }
            let mut available = Vec::new();
            for model in response["response"]["models"]
                .as_array()
                .context("Claude Code did not list models")?
            {
                for key in ["value", "resolvedModel"] {
                    if let Some(id) = model.get(key).and_then(Value::as_str)
                        && !available.iter().any(|known| known == id)
                    {
                        available.push(id.to_owned());
                    }
                }
            }
            return Ok(available);
        }
    })
    .await
}

/// Claude Code accepts more model IDs than it lists, so a miss or a listing failure is a note,
/// never a startup failure. A model matches a listed value, an alias's resolved model, or a listed
/// variant's base ID (`claude-opus-5-5[1m]`).
pub async fn check_claude_models(
    models: &[String],
    variables: &Variables,
    stop: impl Future<Output = ()>,
) -> ModelCheck {
    if models.is_empty() {
        return ModelCheck::Ok;
    }
    let listed = match probe::find_on_path(
        "claude",
        variables
            .get(std::ffi::OsStr::new("PATH"))
            .map(OsString::as_os_str),
    ) {
        Some(executable) => list_claude_models(&executable, variables, stop).await,
        None => Err(anyhow::anyhow!("`claude` is not on PATH")),
    };
    let available = match listed {
        Ok(available) => available,
        Err(error) => {
            return ModelCheck::Skipped(format!(
                "Could not list Claude Code models ({error}); skipping the model check."
            ));
        }
    };
    if available.is_empty() {
        return ModelCheck::Skipped(
            "Claude Code listed no models; skipping the model check.".into(),
        );
    }
    let base = |model: &str| -> String {
        match model.rfind('[') {
            Some(index) if model.ends_with(']') => model[..index].to_owned(),
            _ => model.to_owned(),
        }
    };
    let missing: Vec<_> = models
        .iter()
        .filter(|model| {
            !available
                .iter()
                .any(|known| known == *model || base(known) == **model)
        })
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        ModelCheck::Ok
    } else {
        ModelCheck::Skipped(format!(
            "Claude Code's model list doesn't include {} (it lists {}). Continuing; a Task Attempt reports the provider's error if the model is rejected.",
            missing.join(", "),
            available.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_checks::probe::tests::{exists, gone, script};

    fn path(directory: &Path) -> Variables {
        Variables::from([(
            "PATH".into(),
            format!("{}:/usr/bin:/bin", directory.display()).into(),
        )])
    }

    #[test]
    fn versions_are_found_and_compared_numerically() {
        assert_eq!(
            first_version("codex-cli 0.163.0\n").as_deref(),
            Some("0.163.0")
        );
        assert_eq!(
            first_version("v2.1.280 (Claude Code)").as_deref(),
            Some("2.1.280")
        );
        assert_eq!(first_version("1.2 then 3.4.5").as_deref(), Some("3.4.5"));
        assert_eq!(first_version("no version"), None);
        assert!(compare_versions("0.163.0", "0.99.0").is_gt());
        assert!(compare_versions("0.162.9", "0.163.0").is_lt());
        assert!(compare_versions("1.0", "1.0.0").is_eq());
    }

    #[tokio::test]
    async fn the_codex_cli_must_be_installed_new_enough_and_report_a_version() {
        let temporary = tempfile::tempdir().unwrap();
        let variables = path(temporary.path());
        let missing = check_cli(&CODEX, &variables, std::future::pending())
            .await
            .unwrap();
        assert!(
            missing.starts_with("Codex is not installed: `codex` is not on PATH."),
            "{missing}"
        );
        script(temporary.path(), "codex", "echo codex-cli 0.1.0");
        let old = check_cli(&CODEX, &variables, std::future::pending())
            .await
            .unwrap();
        assert_eq!(
            old,
            format!(
                "Codex 0.1.0 is older than {}, the oldest version SuperTag supports. {}",
                CODEX.minimum, CODEX.install
            )
        );
        script(temporary.path(), "codex", "echo 'no version here'");
        let unknown = check_cli(&CODEX, &variables, std::future::pending())
            .await
            .unwrap();
        assert!(unknown.contains("did not report a version"), "{unknown}");
        script(
            temporary.path(),
            "codex",
            &format!("echo codex-cli {}", CODEX.minimum),
        );
        assert_eq!(
            check_cli(&CODEX, &variables, std::future::pending()).await,
            None
        );
    }

    #[tokio::test]
    async fn a_hanging_version_probe_is_killed_and_reported() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("started");
        script(
            temporary.path(),
            "codex",
            &format!(
                "echo $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let failure = check_cli(&CODEX, &path(temporary.path()), exists(started.clone()))
            .await
            .unwrap();
        assert!(failure.contains("did not report a version"), "{failure}");
        assert!(gone(&started));
    }

    /// A fake app server that answers `initialize` and pages `model/list` twice.
    const CODEX_SERVER: &str = r#"test "$*" = "app-server --listen stdio://" || exit 9
test -z "$CODEX_API_KEY$OPENAI_API_KEY" || exit 8
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo 'not json'; echo '{"id":1,"result":{}}';;
    *'"cursor":"next"'*) echo '{"id":2,"result":{"data":[{"id":"gpt-6-max","model":"gpt-6-max"}]}}';;
    *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"gpt-6-sol"}],"nextCursor":"next"}}';;
  esac
done"#;

    #[tokio::test]
    async fn codex_models_are_checked_against_every_listed_page() {
        let temporary = tempfile::tempdir().unwrap();
        script(temporary.path(), "codex", CODEX_SERVER);
        let variables = path(temporary.path());
        assert_eq!(
            check_codex_models(&["gpt-6-sol".into()], &variables, std::future::pending()).await,
            ModelCheck::Ok
        );
        assert_eq!(
            check_codex_models(&["gpt-6.1-sol".into()], &variables, std::future::pending()).await,
            ModelCheck::Failed(
                "Codex does not offer gpt-6.1-sol for this account. Available models: gpt-6-sol, gpt-6-max."
                    .into()
            )
        );
        assert_eq!(
            check_codex_models(&[], &Variables::new(), std::future::pending()).await,
            ModelCheck::Ok
        );
        script(temporary.path(), "codex", "echo '{\"id\":1,\"error\":{}}'");
        let ModelCheck::Skipped(note) =
            check_codex_models(&["gpt-6-sol".into()], &variables, std::future::pending()).await
        else {
            panic!("a refused listing must skip the check");
        };
        assert!(note.contains("refused initialization"), "{note}");
    }

    /// The real Codex app server, signed out in an empty home, still answers `model/list`.
    #[tokio::test]
    #[ignore = "requires a credential-free Codex binary via SUPERTAG_TEST_CODEX_BINARY"]
    async fn a_real_codex_app_server_lists_models_without_a_credential() {
        let binary =
            std::env::var_os("SUPERTAG_TEST_CODEX_BINARY").expect("SUPERTAG_TEST_CODEX_BINARY");
        let temporary = tempfile::tempdir().unwrap();
        let variables = Variables::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), temporary.path().into()),
            ("CODEX_HOME".into(), temporary.path().into()),
        ]);
        let models = list_codex_models(
            Path::new(&binary),
            &variables,
            tokio::time::sleep(std::time::Duration::from_secs(60)),
        )
        .await
        .unwrap();
        assert!(!models.is_empty());
        assert!(
            models
                .iter()
                .all(|model| !model.is_empty() && !model.contains(char::is_whitespace)),
            "{models:?}"
        );
    }

    #[tokio::test]
    async fn a_hanging_codex_listing_is_killed_and_skipped() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("started");
        script(
            temporary.path(),
            "codex",
            &format!(
                "echo $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let ModelCheck::Skipped(note) = check_codex_models(
            &["gpt-6-sol".into()],
            &path(temporary.path()),
            exists(started.clone()),
        )
        .await
        else {
            panic!("a timed out listing must skip the check");
        };
        assert!(note.contains("timed out"), "{note}");
        assert!(gone(&started));
    }

    #[tokio::test]
    async fn claude_models_match_values_aliases_and_variants_and_only_note_a_miss() {
        let temporary = tempfile::tempdir().unwrap();
        script(
            temporary.path(),
            "claude",
            r#"case "$*" in *"--setting-sources="*) ;; *) exit 9;; esac
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      echo '{"type":"system","subtype":"init"}'
      echo '{"type":"control_response","response":{"subtype":"success","request_id":"supertag-models","response":{"models":[{"value":"opus","resolvedModel":"claude-opus-5-5"},{"value":"claude-sonnet-5-5"},{"value":"claude-fable-5-1[1m]"}]}}}';;
  esac
done"#,
        );
        let variables = path(temporary.path());
        assert_eq!(
            check_claude_models(
                &[
                    "claude-opus-5-5".into(),
                    "claude-sonnet-5-5".into(),
                    "claude-fable-5-1".into()
                ],
                &variables,
                std::future::pending()
            )
            .await,
            ModelCheck::Ok
        );
        let ModelCheck::Skipped(note) = check_claude_models(
            &["claude-haiku-9".into()],
            &variables,
            std::future::pending(),
        )
        .await
        else {
            panic!("an unlisted Claude model is only a note");
        };
        assert!(note.contains("doesn't include claude-haiku-9"), "{note}");
        let ModelCheck::Skipped(note) =
            check_claude_models(&["x".into()], &Variables::new(), std::future::pending()).await
        else {
            panic!("a missing CLI is only a note");
        };
        assert!(note.contains("Could not list Claude Code models"), "{note}");
    }
}
