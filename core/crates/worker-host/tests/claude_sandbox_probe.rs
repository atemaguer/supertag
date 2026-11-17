//! One live Claude Code turn (operator-approved, Haiku, capped): Claude Code's own sandbox with
//! the settings the Claude Code adapter gives a Task with a network scope sends commands' traffic
//! only to the Worker Host's egress proxy. Prints what happened; a person judges. Needs
//! SUPERTAG_LIVE_CLAUDE_SANDBOX=1, a signed-in `claude` on PATH, and spends one Haiku turn.

use std::process::Stdio;

use supertag_protocol::v2::{NetworkRule, NetworkScope};
use supertag_worker_host::egress;

#[tokio::test]
#[ignore = "spends one live Claude turn; run only with operator approval"]
async fn live_claude_sandbox_keeps_commands_to_the_network_scope() -> anyhow::Result<()> {
    if std::env::var_os("SUPERTAG_LIVE_CLAUDE_SANDBOX").is_none() {
        return Ok(());
    }
    let directory = tempfile::tempdir()?;
    let mut config = egress::Config::new(
        NetworkScope {
            any_origin: false,
            rules: vec![NetworkRule {
                origins: vec!["https://example.com".into()],
                methods: vec!["GET".into()],
                credential: String::new(),
                paths: vec![],
            }],
        },
        vec![],
    );
    config.require_password = false;
    let proxy = egress::EgressProxy::start(config).await?;
    let files = egress::write_sandbox_files(&proxy, directory.path())?;
    let port = proxy.address().port();
    // The adapter's `networkSandbox` settings for this scope.
    let settings = serde_json::json!({
        "sandbox": {
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": true,
            "allowUnsandboxedCommands": false,
            "network": {
                "allowedDomains": ["example.com"],
                "strictAllowlist": true,
                "httpProxyPort": port,
                "socksProxyPort": port,
            },
            "filesystem": { "disabled": true },
        },
        "permissions": { "allow": ["Bash"] },
    });
    let prompt = "Run exactly these three shell commands with the Bash tool, one call each, and \
        reply with only their three outputs, one per line:\n\
        curl -sS -m 15 -o /dev/null -w 'allowed=%{http_code}' https://example.com/ || echo allowed-failed=$?\n\
        curl -sS -m 15 -o /dev/null -w 'denied=%{http_code}' https://example.org/ || echo denied-failed=$?\n\
        curl -sS -m 15 --noproxy '*' -o /dev/null -w 'direct=%{http_code}' https://example.org/ || echo direct-failed=$?";
    let bundle = files.ca_bundle.to_str().unwrap().to_owned();
    let output = tokio::process::Command::new("claude")
        .args(["-p", "--model", "claude-haiku-5-5", "--max-turns", "6"])
        .args(["--output-format", "stream-json", "--verbose"])
        .args(["--allowedTools", "Bash", "--setting-sources", ""])
        .arg("--settings")
        .arg(settings.to_string())
        .arg(prompt)
        .current_dir(directory.path())
        .env("SSL_CERT_FILE", &bundle)
        .env("CURL_CA_BUNDLE", &bundle)
        .env("NODE_EXTRA_CA_CERTS", &files.ca_certificate)
        .stdin(Stdio::null())
        .output()
        .await?;
    let log = proxy.stop().await;
    // terminal-safe: probe output for the operator.
    println!(
        "status: {}\nstdout:\n{}\nstderr:\n{}\negress log: {log:#?}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
