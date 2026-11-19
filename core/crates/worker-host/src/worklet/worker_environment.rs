//! The environment a Worker starts with: an allowlist of its Worklet's variables, never the whole
//! of it. Its harness's provider secrets and its Task's network credentials arrive in its
//! `Assign` instead.

use std::ffi::OsString;

/// The process basics every Worker gets.
const BASICS: [&str; 9] = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ",
];
/// The locale variables every Worker gets, such as `LC_ALL` and `LC_CTYPE`.
const LOCALE_PREFIX: &str = "LC_";
/// The proxy and TLS files the transport honours when a Worker dials its data endpoint.
const TRANSPORT: [&str; 7] = [
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "SUPERTAG_SERVER_CA_FILE",
    "SUPERTAG_CLIENT_CERT_FILE",
    "SUPERTAG_CLIENT_KEY_FILE",
];
/// The SuperTag variables every Worker reads: where this machine's SuperTag state is, for the
/// MCP logins it reads. None is a credential.
const SUPERTAG: [&str; 1] = ["SUPERTAG_STATE_DIR"];
/// Test hooks, such as crash points, which only test builds read.
#[cfg(feature = "test-fixtures")]
const TEST_PREFIX: &str = "SUPERTAG_TEST_";

/// Never passed, whatever a harness names: the host credential, a supervisor's lifeline, and the
/// sources of the network credentials.
const HOST_TOKEN: &str = "SUPERTAG_HOST_TOKEN";
const SERVICE_LIFELINE: &str = "SUPERTAG_LOCAL_SERVICE_LIFELINE";
const NETWORK_CREDENTIAL_PREFIX: &str = "SUPERTAG_NETWORK_CREDENTIAL_";

/// Whether every Worker gets `name`, whatever its harness.
fn basic(name: &str) -> bool {
    #[cfg(feature = "test-fixtures")]
    if name.starts_with(TEST_PREFIX) {
        return true;
    }
    BASICS.contains(&name)
        || name.starts_with(LOCALE_PREFIX)
        || TRANSPORT.contains(&name)
        || SUPERTAG.contains(&name)
}

/// The variables of `environment` a Worker starts with: the basics every Worker gets, and the
/// `harness` variables its own harness's configuration reads. Nothing that names the host
/// credential, holds its value, or is a network credential's source passes.
pub(crate) fn for_worker(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
    harness: &[String],
    host_token: &str,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(name, value)| {
            let Some(name) = name.to_str() else {
                return false;
            };
            let withheld = name == HOST_TOKEN
                || name == SERVICE_LIFELINE
                || name.starts_with(NETWORK_CREDENTIAL_PREFIX)
                || (!host_token.is_empty() && value.as_encoded_bytes() == host_token.as_bytes());
            !withheld && (basic(name) || harness.iter().any(|named| named == name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> Vec<(OsString, OsString)> {
        [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/operator"),
            ("USER", "operator"),
            ("LOGNAME", "operator"),
            ("SHELL", "/bin/zsh"),
            ("TMPDIR", "/tmp"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "en_US.UTF-8"),
            ("TERM", "xterm-256color"),
            ("TZ", "UTC"),
            ("HTTPS_PROXY", "http://proxy.test:3128"),
            ("SUPERTAG_SERVER_CA_FILE", "/etc/ca.pem"),
            ("SUPERTAG_STATE_DIR", "/home/operator/.supertag"),
            // Claude Code's and Codex's own configuration.
            (
                "CLAUDE_SECURESTORAGE_CONFIG_DIR",
                "/home/operator/.claude-store",
            ),
            ("CODEX_HOME", "/home/operator/.codex"),
            // A provider key a supervisor left in the environment, and an MCP header.
            ("OPENAI_API_KEY", "sk-codex"),
            ("CATALOG_AUTH", "Bearer mcp"),
            ("MODAL_TOKEN_SECRET", "modal-secret"),
            // The host's own credentials.
            ("SUPERTAG_HOST_TOKEN", "stcr_host"),
            ("SUPERTAG_HOST_TOKEN_COPY", "stcr_host"),
            ("SUPERTAG_NETWORK_CREDENTIAL_GITHUB", "ghp_network"),
            (SERVICE_LIFELINE, "1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect()
    }

    fn names(passed: &[(OsString, OsString)]) -> Vec<&str> {
        passed
            .iter()
            .map(|(name, _)| name.to_str().unwrap())
            .collect()
    }

    #[test]
    fn a_worker_gets_its_own_harness_variables_and_the_basics_only() {
        // Claude Code's Workers name its configuration and the MCP catalog's header variable.
        let claude = for_worker(
            environment(),
            &[
                "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
                "CATALOG_AUTH".into(),
                // Named, but withheld all the same.
                "SUPERTAG_HOST_TOKEN".into(),
                "SUPERTAG_NETWORK_CREDENTIAL_GITHUB".into(),
            ],
            "stcr_host",
        );
        let passed = names(&claude);
        for basic in [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "TERM",
            "TZ",
            "HTTPS_PROXY",
            "SUPERTAG_SERVER_CA_FILE",
            "SUPERTAG_STATE_DIR",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            "CATALOG_AUTH",
        ] {
            assert!(passed.contains(&basic), "{basic} did not pass");
        }
        for withheld in [
            // Codex's configuration and secrets, and a remote provider's.
            "CODEX_HOME",
            "OPENAI_API_KEY",
            "MODAL_TOKEN_SECRET",
            "SUPERTAG_HOST_TOKEN",
            "SUPERTAG_HOST_TOKEN_COPY",
            "SUPERTAG_NETWORK_CREDENTIAL_GITHUB",
            SERVICE_LIFELINE,
        ] {
            assert!(!passed.contains(&withheld), "{withheld} passed");
        }
        assert!(
            claude
                .iter()
                .all(|(_, value)| value != "stcr_host" && value != "ghp_network"),
            "a host or network credential value passed"
        );

        // Codex's Workers get its home, and none of Claude Code's or the MCP catalog's.
        let codex = for_worker(environment(), &["CODEX_HOME".into()], "stcr_host");
        let passed = names(&codex);
        assert!(passed.contains(&"CODEX_HOME") && passed.contains(&"PATH"));
        for withheld in [
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            "CATALOG_AUTH",
            "OPENAI_API_KEY",
        ] {
            assert!(!passed.contains(&withheld), "{withheld} passed");
        }
    }
}
