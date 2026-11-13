//! Sign-in probes for Codex, Claude Code and OpenCode, with the credentials a Worker Host passes
//! to that harness. Where only a model turn proves a credential, the probe runs one tool-free turn
//! in a private temporary directory that is removed afterwards. Only a boolean leaves: native
//! output and errors can contain credentials.
use std::{
    ffi::{OsStr, OsString},
    fs::OpenOptions,
    future::Future,
    io::{Read as _, Write as _},
    os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

use super::probe::{self, PROCESS_VARIABLES, Probe, Variables};

pub const PROMPT: &str = "Reply with OK only.";
const MAX_AUTH_FILE: u64 = 64 * 1024;
const MAX_TURN_OUTPUT: usize = 1024 * 1024;
const MAX_MESSAGE: usize = 1024 * 1024;

fn private_directory(prefix: &str) -> Option<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix(prefix)
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .ok()
}

fn process_variables(variables: &Variables) -> Variables {
    variables
        .iter()
        .filter(|(name, _)| {
            PROCESS_VARIABLES
                .iter()
                .any(|known| OsStr::new(known) == *name)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn executable(command: &str, variables: &Variables) -> Option<PathBuf> {
    probe::find_on_path(
        command,
        variables.get(OsStr::new("PATH")).map(OsString::as_os_str),
    )
}

/// The auth.json a Codex Task copies: `$CODEX_HOME/auth.json`, else `$HOME/.codex/auth.json`.
fn codex_auth_file(variables: &Variables) -> Option<PathBuf> {
    probe::text(variables, "CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| probe::text(variables, "HOME").map(|home| Path::new(&home).join(".codex")))
        .map(|home| home.join("auth.json"))
}

/// Read-only check of a file-backed Codex sign-in. A copied OAuth refresh token must never be
/// rotated by a probe, so its account access is not verified.
fn file_backed_credential(file: std::fs::File) -> bool {
    let mut bytes = Vec::new();
    if file
        .take(MAX_AUTH_FILE + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_AUTH_FILE
    {
        return false;
    }
    let Ok(auth) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let present = |value: &Value| value.as_str().is_some_and(|value| !value.trim().is_empty());
    present(&auth["OPENAI_API_KEY"]) || present(&auth["tokens"]["refresh_token"])
}

/// Codex, with a Task's credential precedence: CODEX_API_KEY, then the selected auth.json, then
/// OPENAI_API_KEY. A readable auth.json is checked without a turn; an API key runs one
/// read-only, tool-free `codex exec` turn in a private CODEX_HOME.
pub async fn codex(
    variables: &Variables,
    model: Option<&str>,
    stop: impl Future<Output = ()>,
) -> bool {
    let mut key = probe::text(variables, "CODEX_API_KEY");
    if key.is_none() {
        if let Some(path) = codex_auth_file(variables)
            && let Ok(file) = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(path)
        {
            return file.metadata().is_ok_and(|metadata| metadata.is_file())
                && file_backed_credential(file);
        }
        key = probe::text(variables, "OPENAI_API_KEY");
    }
    let (Some(key), Some(executable)) = (key, executable("codex", variables)) else {
        return false;
    };
    let Some(directory) = private_directory("supertag-codex-signin-") else {
        return false;
    };
    let home = directory.path().join(".codex");
    if std::fs::create_dir(&home).is_err() {
        return false;
    }
    let mut args: Vec<OsString> = vec!["exec".into(), "--json".into()];
    let mut config = vec![
        "agents.enabled=false".to_owned(),
        "sandbox_workspace_write.network_access=false".into(),
        "web_search=\"disabled\"".into(),
        "approval_policy=\"never\"".into(),
    ];
    for feature in [
        "multi_agent",
        "multi_agent_v2",
        "enable_fanout",
        "apps",
        "enable_mcp_apps",
        "plugins",
        "plugin_sharing",
        "skill_mcp_dependency_install",
        "shell_tool",
        "unified_exec",
        "browser_use",
        "browser_use_external",
        "computer_use",
        "in_app_browser",
        "apply_patch_freeform",
    ] {
        config.push(format!("features.{feature}=false"));
    }
    for value in config {
        args.extend(["--config".into(), value.into()]);
    }
    if let Some(model) = model {
        args.extend(["--model".into(), model.into()]);
    }
    args.extend([
        "--sandbox".into(),
        "read-only".into(),
        "--cd".into(),
        directory.path().into(),
        "--skip-git-repo-check".into(),
    ]);
    let mut environment = process_variables(variables);
    environment.insert("CODEX_HOME".into(), home.into());
    environment.insert("CODEX_API_KEY".into(), key.into());
    let Ok((status, stdout)) = probe::output(
        &executable,
        &args,
        &environment,
        Some(directory.path()),
        Some(PROMPT.as_bytes()),
        MAX_TURN_OUTPUT,
        stop,
    )
    .await
    else {
        return false;
    };
    if !status.success() {
        return false;
    }
    let mut response = String::new();
    let mut completed = false;
    for line in stdout.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return false;
        };
        match event["type"].as_str() {
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                response = event["item"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
            }
            Some("turn.completed") => completed = true,
            Some("turn.failed" | "error") => return false,
            _ => {}
        }
    }
    completed && !response.trim().is_empty()
}

/// Claude Code: one tool-free turn with no settings, Skills, plugins or MCP servers, in a private
/// directory and configuration home. The stored login comes from CLAUDE_SECURESTORAGE_CONFIG_DIR,
/// as for Tasks, or an API key or OAuth token in the environment.
pub async fn claude_code(
    variables: &Variables,
    model: Option<&str>,
    stop: impl Future<Output = ()>,
) -> bool {
    let Some(executable) = executable("claude", variables) else {
        return false;
    };
    let Some(directory) = private_directory("supertag-claude-signin-") else {
        return false;
    };
    let mut environment = process_variables(variables);
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        if let Some(value) = variables.get(OsStr::new(name)) {
            environment.insert(name.into(), value.clone());
        }
    }
    environment.insert(
        "CLAUDE_CONFIG_DIR".into(),
        directory.path().join(".claude-config").into(),
    );
    environment.insert(
        "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
        variables
            .get(OsStr::new("CLAUDE_SECURESTORAGE_CONFIG_DIR"))
            .cloned()
            .unwrap_or_default(),
    );
    let mut args: Vec<OsString> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--setting-sources=",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if let Some(model) = model {
        args.extend(["--model".into(), model.into()]);
    }
    let Ok(probe) = Probe::start(&executable, &args, &environment, Some(directory.path())) else {
        return false;
    };
    probe::bounded(probe, stop, async |probe| {
        probe
            .send(
                &json!({"request_id": "supertag-signin", "type": "control_request",
                "request": {"subtype": "initialize"}}),
            )
            .await?;
        probe
            .send(
                &json!({"type": "user", "session_id": "", "parent_tool_use_id": null,
                "message": {"role": "user", "content": PROMPT}}),
            )
            .await?;
        while let Some(event) = probe.object(MAX_MESSAGE).await? {
            if event["type"] == "result" {
                return Ok(event["subtype"] == "success" && event["is_error"] == false);
            }
        }
        Ok(false)
    })
    .await
    .unwrap_or(false)
}

/// OpenCode: one tool-free `opencode run` turn with only the selected provider's key, in an
/// isolated home that never reads the usual OpenCode auth.json. Every permission is denied.
pub async fn opencode(variables: &Variables, model: &str, stop: impl Future<Output = ()>) -> bool {
    let Ok(names) = supertag_worker_host::provider_environment_for(
        supertag_protocol::v2::HarnessKind::Opencode,
        Some(model),
    ) else {
        return false;
    };
    let Some(executable) = executable("opencode", variables) else {
        return false;
    };
    let Some(directory) = private_directory("supertag-opencode-signin-") else {
        return false;
    };
    let provider = model.split('/').next().unwrap_or_default();
    let credential = names
        .iter()
        .find_map(|name| probe::text(variables, name).map(|value| (*name, value)));
    let home = directory.path().join("home");
    if std::fs::create_dir_all(home.join("opencode")).is_err() {
        return false;
    }
    if let Some((_, key)) = &credential {
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(home.join("opencode").join("auth.json"))
            .and_then(|mut file| {
                file.write_all(
                    json!({ provider: { "type": "api", "key": key } })
                        .to_string()
                        .as_bytes(),
                )
            });
        if written.is_err() {
            return false;
        }
    }
    let permission = json!({"*": "deny"});
    let mut environment = process_variables(variables);
    if let Some((name, key)) = credential {
        environment.insert(name.into(), key.into());
    }
    for name in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] {
        environment.insert(name.into(), home.clone().into());
    }
    environment.insert(
        "OPENCODE_CONFIG_CONTENT".into(),
        json!({
            "model": model,
            "share": "disabled",
            "autoupdate": false,
            "plugin": [],
            "mcp": {},
            "permission": permission,
            "agent": {"build": {"mode": "primary", "permission": permission}},
        })
        .to_string()
        .into(),
    );
    environment.insert("OPENCODE_PERMISSION".into(), permission.to_string().into());
    for name in [
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
    ] {
        environment.insert(name.into(), "true".into());
    }
    let args: Vec<OsString> = [
        "run", "--format", "json", "--model", model, "--agent", "build", "--pure", PROMPT,
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let Ok((_, stdout)) = probe::output(
        &executable,
        &args,
        &environment,
        Some(directory.path()),
        None,
        MAX_TURN_OUTPUT,
        stop,
    )
    .await
    else {
        return false;
    };
    let mut text = false;
    let mut stopped = false;
    for line in stdout.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return false;
        };
        match event["type"].as_str() {
            Some("error") => return false,
            Some("text") => {
                text |= event["part"]["text"]
                    .as_str()
                    .is_some_and(|value| !value.trim().is_empty());
            }
            Some("step_finish") => stopped |= event["part"]["reason"] == "stop",
            _ => {}
        }
    }
    text && stopped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_checks::probe::tests::{exists, gone, script};

    fn variables(directory: &Path, extra: &[(&str, &str)]) -> Variables {
        let mut variables = Variables::from([
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", directory.display()).into(),
            ),
            ("HOME".into(), directory.join("home").into()),
        ]);
        for (name, value) in extra {
            variables.insert(name.into(), value.into());
        }
        variables
    }

    /// A fake that records its arguments, environment and working directory, then answers.
    fn recording(directory: &Path, name: &str, answer: &str) {
        script(
            directory,
            name,
            &format!(
                "printf '%s\\n' \"$@\" > '{0}/{name}.args'\n/usr/bin/env > '{0}/{name}.env'\npwd > '{0}/{name}.cwd'\ncat > '{0}/{name}.stdin'\n{answer}",
                directory.display()
            ),
        );
    }

    fn read(directory: &Path, file: &str) -> String {
        std::fs::read_to_string(directory.join(file)).unwrap_or_default()
    }

    #[tokio::test]
    async fn codex_runs_a_turn_with_only_the_selected_key_in_a_removed_home() {
        let temporary = tempfile::tempdir().unwrap();
        recording(
            temporary.path(),
            "codex",
            r#"echo '{"type":"thread.started"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'
echo '{"type":"turn.completed"}'"#,
        );
        let variables = variables(
            temporary.path(),
            &[
                ("CODEX_API_KEY", "preferred"),
                ("OPENAI_API_KEY", "fallback"),
                ("UNRELATED_SECRET", "never-pass"),
            ],
        );
        assert!(codex(&variables, Some("gpt-6-sol"), std::future::pending()).await);
        let environment = read(temporary.path(), "codex.env");
        assert!(
            environment.contains("CODEX_API_KEY=preferred"),
            "{environment}"
        );
        assert!(!environment.contains("OPENAI_API_KEY"), "{environment}");
        assert!(!environment.contains("UNRELATED_SECRET"), "{environment}");
        let args = read(temporary.path(), "codex.args");
        for expected in [
            "exec",
            "read-only",
            "--skip-git-repo-check",
            "approval_policy=\"never\"",
            "gpt-6-sol",
        ] {
            assert!(args.lines().any(|line| line == expected), "{args}");
        }
        assert_eq!(read(temporary.path(), "codex.stdin"), PROMPT);
        let home = environment
            .lines()
            .find_map(|line| line.strip_prefix("CODEX_HOME="))
            .unwrap();
        assert!(!Path::new(home).exists(), "the probe home was not removed");
        assert!(!Path::new(read(temporary.path(), "codex.cwd").trim()).exists());

        // OPENAI_API_KEY is used when neither CODEX_API_KEY nor an auth file is present.
        let fallback = variables
            .iter()
            .filter(|(name, _)| *name != "CODEX_API_KEY")
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        assert!(codex(&fallback, None, std::future::pending()).await);
        assert!(read(temporary.path(), "codex.env").contains("CODEX_API_KEY=fallback"));
    }

    #[tokio::test]
    async fn a_file_backed_codex_login_is_checked_without_a_turn_or_a_change() {
        let temporary = tempfile::tempdir().unwrap();
        recording(temporary.path(), "codex", "exit 1");
        let source = temporary.path().join("home/.codex");
        std::fs::create_dir_all(&source).unwrap();
        let auth = r#"{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}"#;
        std::fs::write(source.join("auth.json"), auth).unwrap();
        let variables = variables(temporary.path(), &[("OPENAI_API_KEY", "ignored")]);
        assert!(codex(&variables, None, std::future::pending()).await);
        assert!(!temporary.path().join("codex.args").exists());
        assert_eq!(
            std::fs::read_to_string(source.join("auth.json")).unwrap(),
            auth
        );
        // A stale file is not trusted, and no turn is run to find out.
        std::fs::write(source.join("auth.json"), "{}").unwrap();
        assert!(!codex(&variables, None, std::future::pending()).await);
        assert!(!temporary.path().join("codex.args").exists());
        // CODEX_HOME selects the file.
        let selected = temporary.path().join("selected");
        std::fs::create_dir(&selected).unwrap();
        std::fs::write(
            selected.join("auth.json"),
            r#"{"OPENAI_API_KEY":"file-key"}"#,
        )
        .unwrap();
        let mut variables = variables;
        variables.insert("CODEX_HOME".into(), selected.into());
        assert!(codex(&variables, None, std::future::pending()).await);
    }

    #[tokio::test]
    async fn codex_failures_and_missing_credentials_are_not_sign_in() {
        let temporary = tempfile::tempdir().unwrap();
        recording(
            temporary.path(),
            "codex",
            r#"echo '{"type":"turn.failed","error":{"message":"401 Unauthorized test-secret"}}'; exit 1"#,
        );
        assert!(
            !codex(
                &variables(temporary.path(), &[]),
                None,
                std::future::pending()
            )
            .await
        );
        assert!(
            !temporary.path().join("codex.args").exists(),
            "no credential, no launch"
        );
        let keyed = variables(temporary.path(), &[("CODEX_API_KEY", "test-secret")]);
        assert!(!codex(&keyed, None, std::future::pending()).await);
        // A zero exit with no answer is not sign-in either.
        recording(
            temporary.path(),
            "codex",
            r#"echo '{"type":"turn.completed"}'"#,
        );
        assert!(!codex(&keyed, None, std::future::pending()).await);
    }

    #[tokio::test]
    async fn a_hanging_codex_turn_is_killed_and_its_home_removed() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("started");
        script(
            temporary.path(),
            "codex",
            &format!(
                "echo \"$CODEX_HOME\" > '{0}.home'\necho $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let keyed = variables(temporary.path(), &[("CODEX_API_KEY", "test-secret")]);
        assert!(!codex(&keyed, None, exists(started.clone())).await);
        assert!(gone(&started));
        let home = std::fs::read_to_string(started.with_extension("home")).unwrap();
        assert!(!Path::new(home.trim()).exists());
    }

    #[tokio::test]
    async fn claude_needs_a_successful_result_from_an_isolated_tool_free_turn() {
        let temporary = tempfile::tempdir().unwrap();
        let answer = |result: &str| {
            format!(
                r#"printf '%s\n' "$@" > '{0}/claude.args'
/usr/bin/env > '{0}/claude.env'
pwd > '{0}/claude.cwd'
while IFS= read -r line; do
  case "$line" in
    *'"type":"user"'*) echo "$line" > '{0}/claude.prompt'; echo '{{"type":"system","subtype":"init"}}'; echo '{result}';;
  esac
done"#,
                temporary.path().display()
            )
        };
        script(
            temporary.path(),
            "claude",
            &answer(r#"{"type":"result","subtype":"success","is_error":false}"#),
        );
        let variables = variables(
            temporary.path(),
            &[
                ("ANTHROPIC_API_KEY", "test-secret"),
                ("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/selected-store"),
                ("UNRELATED_SECRET", "never-pass"),
            ],
        );
        assert!(claude_code(&variables, None, std::future::pending()).await);
        let environment = read(temporary.path(), "claude.env");
        assert!(environment.contains("ANTHROPIC_API_KEY=test-secret"));
        assert!(environment.contains("CLAUDE_SECURESTORAGE_CONFIG_DIR=/selected-store"));
        assert!(!environment.contains("UNRELATED_SECRET"));
        let config = environment
            .lines()
            .find_map(|line| line.strip_prefix("CLAUDE_CONFIG_DIR="))
            .unwrap();
        assert!(
            !Path::new(config).exists(),
            "the probe directory was not removed"
        );
        let args = read(temporary.path(), "claude.args");
        for expected in [
            "--strict-mcp-config",
            "--setting-sources=",
            "--no-session-persistence",
            "dontAsk",
        ] {
            assert!(args.lines().any(|line| line == expected), "{args}");
        }
        assert!(read(temporary.path(), "claude.prompt").contains(PROMPT));
        for failed in [
            r#"{"type":"result","subtype":"success","is_error":true}"#,
            r#"{"type":"result","subtype":"error_during_execution","errors":["Please run /login test-secret"]}"#,
        ] {
            script(temporary.path(), "claude", &answer(failed));
            assert!(!claude_code(&variables, None, std::future::pending()).await);
        }
        script(temporary.path(), "claude", "exit 0");
        assert!(!claude_code(&variables, None, std::future::pending()).await);
    }

    #[tokio::test]
    async fn opencode_uses_only_the_selected_provider_key_in_a_removed_home() {
        let temporary = tempfile::tempdir().unwrap();
        recording(
            temporary.path(),
            "opencode",
            &format!(
                "cp \"$HOME/opencode/auth.json\" '{}/auth.json'\n\
                 echo '{{\"type\":\"text\",\"part\":{{\"text\":\"OK\"}}}}'\n\
                 echo '{{\"type\":\"step_finish\",\"part\":{{\"reason\":\"stop\"}}}}'",
                temporary.path().display()
            ),
        );
        let variables = variables(
            temporary.path(),
            &[
                ("OPENAI_API_KEY", "test-secret"),
                ("ANTHROPIC_API_KEY", "other-provider"),
                ("UNRELATED_SECRET", "never-pass"),
            ],
        );
        assert!(opencode(&variables, "openai/model", std::future::pending()).await);
        let auth: Value = serde_json::from_str(&read(temporary.path(), "auth.json")).unwrap();
        assert_eq!(
            auth,
            json!({"openai": {"type": "api", "key": "test-secret"}})
        );
        let environment = read(temporary.path(), "opencode.env");
        assert!(!environment.contains("UNRELATED_SECRET"));
        assert!(!environment.contains("other-provider"));
        assert!(environment.contains("OPENCODE_DISABLE_PROJECT_CONFIG=true"));
        assert!(environment.contains(r#"OPENCODE_PERMISSION={"*":"deny"}"#));
        let home = environment
            .lines()
            .find_map(|line| line.strip_prefix("HOME="))
            .unwrap();
        assert!(!Path::new(home).exists());
        // A successful exit alone is not sign-in.
        recording(
            temporary.path(),
            "opencode",
            "echo 'credential test-secret' >&2",
        );
        assert!(!opencode(&variables, "openai/model", std::future::pending()).await);
        recording(
            temporary.path(),
            "opencode",
            r#"echo '{"type":"text","part":{"text":"OK"}}'; echo '{"type":"error"}'; echo '{"type":"step_finish","part":{"reason":"stop"}}'"#,
        );
        assert!(!opencode(&variables, "openai/model", std::future::pending()).await);
    }

    #[tokio::test]
    async fn a_hanging_opencode_turn_is_killed() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("started");
        script(
            temporary.path(),
            "opencode",
            &format!(
                "echo $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let variables = variables(temporary.path(), &[("OPENAI_API_KEY", "test-secret")]);
        assert!(!opencode(&variables, "openai/model", exists(started.clone())).await);
        assert!(gone(&started));
    }
}
