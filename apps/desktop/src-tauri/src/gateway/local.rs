//! The local Gateway `supertag up` runs from this user's state directory
//! (`SUPERTAG_STATE_DIR`, else `~/.supertag`). It is found with the CLI's own discovery code and
//! its operator token is read at each connect, never saved, because `supertag up` may replace it.
use std::path::Path;

use serde::Serialize;
use supertag_protocol::{
    negotiation::{NegotiationError, PROTOCOL_VERSIONS, connect},
    v2::ServiceRole,
};

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

/// The local Gateway runs an older SuperTag release than this app, one the app can restart with
/// its own CLI: `running` is that release, `version` the app's.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpgrade {
    running: String,
    version: String,
}

impl super::GatewayState {
    /// Whether the local Gateway runs now from an older SuperTag release than this app, which
    /// speaks only older protocol versions. A Gateway newer than the app, or one whose release
    /// can't be told, is never offered a restart: the app's CLI would run it backwards.
    pub async fn local_upgrade(&self) -> Option<LocalUpgrade> {
        let local = discover(self.2.as_deref()).ok()?;
        let channel = super::endpoint(&local.url).ok()?.connect().await.ok()?;
        let mismatch = match connect(channel, ServiceRole::Client, ServiceRole::Gateway).await {
            Err(NegotiationError::Mismatch(mismatch)) => mismatch,
            _ => return None,
        };
        let running = mismatch.peer_build()?;
        older(mismatch.peer_versions()?, PROTOCOL_VERSIONS).then(|| LocalUpgrade {
            running: running.to_owned(),
            version: crate::local_start::APP_VERSION.to_owned(),
        })
    }
}

/// Whether every protocol version `peer` speaks is older than all of `ours`.
fn older(peer: &[u32], ours: &[u32]) -> bool {
    match (peer.iter().max(), ours.iter().min()) {
        (Some(peer), Some(ours)) => peer < ours,
        _ => false,
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

#[cfg(test)]
mod tests {
    use super::older;

    #[test]
    fn only_a_release_that_speaks_older_protocols_is_older() {
        assert!(older(&[2], &[6]));
        assert!(older(&[2, 5], &[6, 7]));
        assert!(!older(&[7], &[6]));
        assert!(!older(&[5, 6], &[6]));
        assert!(!older(&[], &[6]));
    }
}
