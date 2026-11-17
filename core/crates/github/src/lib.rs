//! GitHub App and token authentication, which the Gateway's GitHub connector uses. Workspace
//! source and delivery are git delivery's (`supertag-git-delivery`) and work with any git server.

pub mod auth;

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
