//! The local Gateway `supertag up` runs from this user's state directory
//! (`SUPERTAG_STATE_DIR`, else `~/.supertag`). It is found with the CLI's own discovery code and
//! its operator token is read at each connect, never saved, because `supertag up` may replace it.
use std::path::Path;

use serde::Serialize;

use super::Result;

/// The identity the app gives the local Gateway in place of a saved origin. Saved origins
/// always contain `://`, so the two never collide.
pub const LOCAL: &str = "local";

/// Whether the local Gateway is running: its origin when it is, else why not.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGateway {
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

/// The local Gateway's URL and its current operator token.
pub(super) struct Discovered {
    pub url: String,
    pub token: String,
}

pub(super) fn status(state: Option<&Path>) -> LocalGateway {
    match discover(state) {
        Ok(local) => LocalGateway {
            origin: Some(local.url),
            problem: None,
        },
        Err(problem) => LocalGateway {
            origin: None,
            problem: Some(problem),
        },
    }
}

#[cfg(unix)]
pub(super) fn discover(state: Option<&Path>) -> Result<Discovered> {
    let state = state.ok_or(
        "Could not locate the local SuperTag state directory. Set HOME or SUPERTAG_STATE_DIR.",
    )?;
    // The errors name files and permissions, never the credential.
    match supertag_local_state::gateway(state) {
        Ok(Some(local)) => Ok(Discovered {
            url: local.url,
            token: local.token,
        }),
        Ok(None) => Err(supertag_local_state::not_running(state)),
        Err(error) => Err(format!(
            "Could not read the local Gateway in {}: {error:#}",
            state.display()
        )),
    }
}

#[cfg(not(unix))]
pub(super) fn discover(_: Option<&Path>) -> Result<Discovered> {
    Err("A local Gateway runs only on macOS and Linux.".into())
}
