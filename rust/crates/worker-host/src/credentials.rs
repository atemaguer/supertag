//! Explicit provider selection; service credentials and ambient native config never cross.
use anyhow::{Result, ensure};
use supertag_protocol::v2::HarnessKind;

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
