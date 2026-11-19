//! Explicit provider selection; service credentials and ambient native config never cross.
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, ffi::OsString, path::Path, sync::OnceLock};
use supertag_protocol::v2::HarnessKind;

/// Provider credentials this Worker's `Assign` carried, which its Worklet read from a file at
/// start rather than its environment.
static FILE_CREDENTIALS: OnceLock<BTreeMap<String, String>> = OnceLock::new();

/// Whether a provider variable holds a secret (a key or token), as opposed to a path such as
/// `HOME`. Supervisors hand secrets to a Worker Host in a file, never its environment.
pub fn is_provider_secret(name: &str) -> bool {
    name.ends_with("_KEY") || name.ends_with("_TOKEN")
}

/// Read the provider credentials a supervisor wrote for one harness of this Worker Host (a JSON
/// object of variable to value) and delete the file. The values then stay out of the host's
/// initial environment, where `ps eww`, `/proc/<pid>/environ`, and crash or debug dumps of the
/// environment would show them. The Worklet keeps them and hands each Worker only its own
/// harness's, in its `Assign`. This closes accidental leaks only: a command running as the same
/// user can still read the host's memory where the OS lets it.
pub fn read_provider_credentials(path: &Path) -> Result<BTreeMap<String, String>> {
    let bytes = std::fs::read(path).context("read the provider credentials file")?;
    std::fs::remove_file(path).context("remove the provider credentials file")?;
    let credentials: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).context("parse the provider credentials file")?;
    ensure!(
        credentials.keys().all(|name| is_provider_secret(name)),
        "the provider credentials file names a variable that is not a key or token"
    );
    Ok(credentials)
}

/// Installs the provider credentials a Worker's `Assign` carried, once per Worker process.
pub(crate) fn set_provider_credentials(credentials: BTreeMap<String, String>) -> Result<()> {
    ensure!(
        credentials.keys().all(|name| is_provider_secret(name)),
        "provider credentials name a variable that is not a key or token"
    );
    ensure!(
        FILE_CREDENTIALS.set(credentials).is_ok(),
        "provider credentials are already loaded"
    );
    Ok(())
}

/// The values of the provider credentials this Worker was assigned, which its redaction hides.
pub(crate) fn assigned_values() -> Vec<String> {
    FILE_CREDENTIALS
        .get()
        .map(|credentials| credentials.values().cloned().collect())
        .unwrap_or_default()
}

/// A provider variable's value: from the credentials the Worker was assigned, else from the
/// host's environment.
pub fn provider_variable(name: &str) -> Option<OsString> {
    FILE_CREDENTIALS
        .get()
        .and_then(|credentials| credentials.get(name))
        .map(OsString::from)
        .or_else(|| std::env::var_os(name))
}

pub fn provider_environment(harness: HarnessKind) -> &'static [&'static str] {
    match harness {
        HarnessKind::Codex => &["HOME", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
        HarnessKind::ClaudeCode => &[
            "HOME",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ],
        HarnessKind::OpenaiAgents => &["OPENAI_API_KEY"],
        HarnessKind::Cursor => &["CURSOR_API_KEY"],
        HarnessKind::Opencode | HarnessKind::Unspecified => &[],
    }
}
pub fn validate_opencode_model(model: &str) -> Result<&str> {
    let (provider, model_id) = model.split_once('/').unwrap_or_default();
    ensure!(
        !provider.is_empty()
            && !model_id.is_empty()
            && !model.chars().any(|c| c.is_whitespace() || c.is_control()),
        "OpenCode model must be provider/model"
    );
    Ok(provider)
}
pub fn provider_environment_for(
    harness: HarnessKind,
    model: Option<&str>,
) -> Result<&'static [&'static str]> {
    if harness != HarnessKind::Opencode {
        return Ok(provider_environment(harness));
    }
    let provider = validate_opencode_model(model.ok_or_else(|| {
        anyhow::anyhow!("--harness-model provider/model is required for OpenCode")
    })?)?;
    Ok(match provider {
        "openai" => &["OPENAI_API_KEY"],
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "google" => &["GOOGLE_GENERATIVE_AI_API_KEY"],
        "groq" => &["GROQ_API_KEY"],
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY"],
        "azure" => &["AZURE_OPENAI_API_KEY"],
        "mistral" => &["MISTRAL_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        _ => &[],
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_credentials_file_is_read_once_and_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("provider-credentials.json");
        std::fs::write(&path, r#"{"FIXTURE_PROVIDER_API_KEY":"sk-from-file"}"#).unwrap();
        let credentials = read_provider_credentials(&path).unwrap();
        assert!(!path.exists(), "the host deletes the file once read");
        assert!(read_provider_credentials(&path).is_err());
        std::fs::write(&path, r#"{"HOME":"/tmp"}"#).unwrap();
        assert!(read_provider_credentials(&path).is_err());
        set_provider_credentials(credentials).unwrap();
        assert_eq!(
            provider_variable("FIXTURE_PROVIDER_API_KEY"),
            Some(OsString::from("sk-from-file"))
        );
        assert_eq!(provider_variable("FIXTURE_PROVIDER_UNSET_KEY"), None);
        assert!(set_provider_credentials(BTreeMap::new()).is_err());
    }
    #[test]
    fn only_keys_and_tokens_are_secrets() {
        assert!(is_provider_secret("ANTHROPIC_API_KEY"));
        assert!(is_provider_secret("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!is_provider_secret("HOME"));
        assert!(!is_provider_secret("CODEX_HOME"));
        assert!(!is_provider_secret("CLAUDE_SECURESTORAGE_CONFIG_DIR"));
    }
    #[test]
    fn cursor_receives_only_its_api_key() {
        assert_eq!(
            provider_environment(HarnessKind::Cursor),
            ["CURSOR_API_KEY"]
        );
        assert_eq!(
            provider_environment_for(HarnessKind::Cursor, None).unwrap(),
            ["CURSOR_API_KEY"]
        );
        assert_eq!(
            provider_environment_for(HarnessKind::Cursor, Some("fixture-model")).unwrap(),
            ["CURSOR_API_KEY"]
        );
    }
    #[test]
    fn selected_provider_receives_exactly_its_legacy_key() {
        for (provider, key) in [
            ("openai", "OPENAI_API_KEY"),
            ("anthropic", "ANTHROPIC_API_KEY"),
            ("google", "GOOGLE_GENERATIVE_AI_API_KEY"),
            ("groq", "GROQ_API_KEY"),
            ("deepseek", "DEEPSEEK_API_KEY"),
            ("openrouter", "OPENROUTER_API_KEY"),
            ("azure", "AZURE_OPENAI_API_KEY"),
            ("mistral", "MISTRAL_API_KEY"),
            ("xai", "XAI_API_KEY"),
        ] {
            assert_eq!(
                provider_environment_for(
                    HarnessKind::Opencode,
                    Some(&format!("{provider}/fixture/model"))
                )
                .unwrap(),
                [key]
            );
        }
        assert!(
            provider_environment_for(HarnessKind::Opencode, Some("opencode/free-model"))
                .unwrap()
                .is_empty()
        );
        for model in [
            "",
            "openai",
            "/model",
            "openai/",
            "openai/model extra",
            "openai/model\0",
        ] {
            assert!(validate_opencode_model(model).is_err(), "{model:?}");
        }
        assert!(provider_environment_for(HarnessKind::Opencode, None).is_err());
        assert!(provider_environment(HarnessKind::Opencode).is_empty());
    }
}
