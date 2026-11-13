//! GitHub as the Control Plane uses it: App and token authentication, GitHub Workspace sources
//! read with a source-read token, and pull request publication. The Gateway's GitHub connector
//! shares the authentication; nothing here handles surface events.

pub mod auth;
pub mod publication;
pub mod workspaces;

pub use auth::{GithubAppConfig, GithubAuthentication, setup_app_jwt};

/// The bound on one GitHub API request, including token minting.
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A GitHub numeric ID that fits the API's signed 64-bit range.
pub fn valid_id(id: u64) -> bool {
    id > 0 && id <= i64::MAX as u64
}

/// `OWNER/NAME` with GitHub's allowed characters.
pub fn valid_repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
}
