//! What `supertag deploy` needs from a place to deploy to, in two interfaces so that where the
//! services run and where their secrets are kept stay separate choices.
//!
//! A [`Target`] is the compute: it rolls an image out with its settings and reports the endpoint.
//! A [`SecretStore`] holds the deployment's secrets. Today the only target is Modal and the only
//! store is that target's own; a server or a cluster would pair its target with another store,
//! such as HashiCorp Vault or Kubernetes Secrets.
//!
//! The command in `deploy.rs` owns everything that is the same everywhere: reading the
//! configuration, validating it with the per-platform rules of `deployment.rs`, generating
//! secrets once, issuing the certificate, waiting for health, verifying, and printing the next
//! steps. An implementation never generates a secret or decides what a setting means.
use std::collections::BTreeMap;

use anyhow::Result;

use crate::deployment::Platform;

/// The variables of one secret, by name.
pub(crate) type Values = BTreeMap<String, String>;

/// Where a deployment's secrets are kept. Names are the command's own (`operator-token`,
/// `tls`, `env-vault-token`); the store maps them to whatever it calls them. Nothing here may
/// print a value or pass one in a process's arguments.
pub(crate) trait SecretStore {
    /// The store, for messages: "Modal secrets in workspace acme".
    fn describe(&self) -> String;
    /// The names of this deployment's secrets that exist.
    fn list(&self) -> Result<Vec<String>>;
    /// A secret's variables, or `None` when the store never returns values (Modal's does not).
    fn read(&self, name: &str) -> Result<Option<Values>>;
    /// Creates a secret, or with `replace` creates or replaces every variable of it. Without
    /// `replace`, an existing secret is an error.
    fn write(&self, name: &str, values: &Values, replace: bool) -> Result<()>;
    /// Deletes a secret. A missing one is an error.
    fn delete(&self, name: &str) -> Result<()>;
}

/// What a target can do. The command chooses its defaults from these, never from which target
/// it is, so a new target gets the right behaviour by declaring what it has.
///
/// Add a flag when the command gains a decision that depends on one: whether the endpoint's
/// URL is stable, or whether the deployment is always on or scales to zero, for example.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Capabilities {
    /// A disk that survives restarts, where the services can keep a credential file. Without
    /// one, the services read credentials from the secret store (`credential-vault: env`).
    pub durable_disk: bool,
    /// Clients reach the Control Plane's native gRPC. Otherwise an edge terminates TLS and
    /// forwards only HTTP, and clients use the WebSocket tunnel, a `wss://` URL.
    pub native_grpc: bool,
}

impl Capabilities {
    /// What `deployment.rs` already records about a platform.
    pub(crate) fn of(platform: Platform) -> Self {
        Self {
            durable_disk: !platform.lacks_durable_disk(),
            native_grpc: !platform.tunnelled(),
        }
    }
}

/// One rollout: what runs, with which settings and secrets.
pub(crate) struct Rollout<'a> {
    /// The hosted image, pinned by digest.
    pub image: &'a str,
    /// The Gateway's connector flags, or `None` to run the Control Plane alone.
    pub gateway_flags: Option<&'a [String]>,
    /// Non-secret settings both services read from their environment.
    pub settings: &'a Values,
    /// The secrets the services read, by the names given to [`SecretStore::write`].
    pub secrets: &'a [String],
}

/// Where a rolled-out deployment answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoint {
    /// The URL operators, Worker Hosts, and Gateways use: `wss://` behind an edge that forwards
    /// only HTTP, `https://` for native gRPC.
    pub url: String,
    /// A plain HTTPS URL that answers 200 once the service listens, when the target has one.
    pub health: Option<String>,
}

/// What a target says it runs now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deployment {
    /// The target's own word for the deployment's state, such as `deployed`; `None` when
    /// nothing is deployed.
    pub state: Option<String>,
    /// Where it answers. More than one when the target cannot tell which it is; the one that
    /// answers its health check is the endpoint.
    pub endpoints: Vec<Endpoint>,
}

/// A place the Control Plane and its optional Gateway run.
pub(crate) trait Target {
    /// The platform whose rules in `deployment.rs` apply: its role contract, where the Gateway
    /// reaches the Control Plane, whether clients use the tunnel, and which credential vaults
    /// it supports.
    fn platform(&self) -> Platform;
    /// What this target can do. A target on a platform `deployment.rs` knows has that
    /// platform's capabilities; any other declares its own.
    fn capabilities(&self) -> Capabilities {
        Capabilities::of(self.platform())
    }
    /// This deployment's name: its private directory on this machine and its saved Gateway.
    fn name(&self) -> String;
    /// Checks, before anything changes, that this machine can deploy: the target's tooling is
    /// present and signed in to the account the configuration names.
    fn prepare(&self) -> Result<()>;
    /// The target's own secret store, or `None` when it has none.
    fn secrets(&self) -> Option<&dyn SecretStore>;
    /// The host names the endpoint may have, known before the first rollout, for a generated
    /// certificate to name. May be empty; the rollout's endpoint is checked against the
    /// certificate afterwards.
    fn hosts(&self) -> Result<Vec<String>>;
    /// Rolls the deployment out and returns its endpoint. Runs again with the same input
    /// without harm.
    fn roll_out(&self, rollout: &Rollout<'_>) -> Result<Endpoint>;
    /// What the target runs now, asked of the target itself.
    fn deployment(&self) -> Result<Deployment>;
    /// One sentence on where to look when the deployment does not become healthy.
    fn troubleshooting(&self) -> String;
}
