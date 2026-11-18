//! Git delivery: SuperTag's only component that talks to a Workspace's git remote. It reads each
//! Session's source for the Control Plane to relay to Worker Hosts, and lands verified Session
//! commits: the Session's branch, or a merge into the Workspace's target, pushed fast-forward
//! only. It needs nothing beyond fetch, push, refs, and bundles, so it works with any git server.
//!
//! Workspace Credentials stay with git delivery. A Worker Host never holds one, and a harness
//! never sees one: hosts receive source as relayed bundles, and pushing happens after the Task,
//! from its verified delivery bundle.

pub mod check;
pub mod credentials;
mod git;
pub mod landing;
pub mod review;
pub mod source;

use std::{
    os::unix::fs::{DirBuilderExt as _, MetadataExt as _},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    git_remote::{RemoteTransport, remote_transport},
    v2::{BlobHolder, Workspace, WorkspaceDeliveryReference},
};
use tempfile::TempDir;

pub use credentials::{Credential, Credentials};

/// Reads a complete bundle of a Workspace delivery's commit from the Worker Host that holds it.
/// The Control Plane stores no delivery bytes; its relay writes them to `destination`. The bundle
/// has no recorded digest: git delivery checks it with git against the delivered commit.
#[tonic::async_trait]
pub trait BundleReader: Send + Sync + 'static {
    async fn read(
        &self,
        holder: &BlobHolder,
        delivery: &WorkspaceDeliveryReference,
        destination: &Path,
    ) -> Result<()>;
}

/// Which credential of a Workspace an operation uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Push,
}

const SCRATCH_PREFIX: &str = "operation-";

/// Git delivery's state: a private directory for scratch and remembered SSH host keys, and the
/// credential vault.
#[derive(Clone)]
pub struct GitDelivery(Arc<Inner>);

struct Inner {
    directory: PathBuf,
    credentials: Credentials,
    http: reqwest::Client,
}

/// One remote, with the credential an operation presents to it.
pub(crate) struct Remote {
    pub(crate) url: String,
    pub(crate) transport: RemoteTransport,
    pub(crate) credential: Option<(String, Credential)>,
    /// A GitHub App credential's token, minted for this operation's repository and access.
    pub(crate) minted: Option<String>,
}

/// A private scratch directory for one operation, with the git settings that reach its remote.
pub(crate) struct Session {
    pub(crate) directory: TempDir,
    pub(crate) settings: git::Settings,
    pub(crate) transport: RemoteTransport,
    pub(crate) url: String,
}

impl Session {
    pub(crate) fn command(&self, directory: &Path) -> tokio::process::Command {
        git::command(directory, Some(self.transport), &self.settings)
    }
}

impl GitDelivery {
    /// `directory` is created private if missing. Scratch a stopped process left is removed.
    pub fn new(directory: &Path, credentials: Credentials) -> Result<Self> {
        if !directory.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)
                .context("create git delivery's private directory")?;
        }
        let metadata = directory.symlink_metadata()?;
        ensure!(
            metadata.is_dir()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0,
            "git delivery's directory {} must be a private directory of this user",
            directory.display()
        );
        let directory = directory.canonicalize()?;
        credentials::sweep(&directory, SCRATCH_PREFIX)?;
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .context("build git delivery's HTTP client")?;
        Ok(Self(Arc::new(Inner {
            directory,
            credentials,
            http,
        })))
    }

    fn trusted_hosts(&self) -> PathBuf {
        self.0.directory.join("known_hosts")
    }

    /// The remote of `workspace` with the credential `access` uses: the named read or push
    /// credential, falling back to the other one, or none.
    pub(crate) async fn remote(&self, workspace: &Workspace, access: Access) -> Result<Remote> {
        let transport = remote_transport(&workspace.remote).map_err(anyhow::Error::msg)?;
        let names = workspace.credentials.clone().unwrap_or_default();
        let name = match access {
            Access::Read if !names.read.is_empty() => names.read,
            Access::Push if !names.push.is_empty() => names.push,
            _ if !names.read.is_empty() => names.read,
            _ => names.push,
        };
        let credential = if name.is_empty() {
            None
        } else {
            Some((name.clone(), self.0.credentials.resolve(&name).await?))
        };
        let minted = match &credential {
            Some((name, credential @ Credential::GithubApp { .. })) => {
                let permission = match access {
                    Access::Read => ("contents", "read"),
                    Access::Push => ("contents", "write"),
                };
                let (token, _) = self
                    .github_token(&workspace.remote, credential, &[permission])
                    .await
                    .with_context(|| format!("Workspace Credential {name}"))?;
                Some(token)
            }
            _ => None,
        };
        Ok(Remote {
            url: workspace.remote.clone(),
            transport,
            credential,
            minted,
        })
    }

    /// A token for the GitHub repository `remote` names, from a GitHub App credential, with
    /// exactly `permissions`, and the repository's ID.
    pub(crate) async fn github_token(
        &self,
        remote: &str,
        credential: &Credential,
        permissions: &[(&str, &str)],
    ) -> Result<(String, u64)> {
        let Credential::GithubApp {
            app_id,
            installation_id,
            private_key_pem,
        } = credential
        else {
            anyhow::bail!("not a GitHub App credential");
        };
        let github = supertag_protocol::git_remote::github_remote(remote).context(
            "a GitHub App Workspace Credential reaches only GitHub repositories, named OWNER/NAME",
        )?;
        ensure!(
            remote_transport(remote).map_err(anyhow::Error::msg)? == RemoteTransport::Http,
            "a GitHub App Workspace Credential reaches only https:// remotes"
        );
        let app = supertag_github::auth::GithubApp::new(&supertag_github::GithubAppConfig {
            app_id: *app_id,
            installation_id: *installation_id,
            private_key_pem: private_key_pem.clone(),
        })?;
        let token = app
            .repository_token(
                &self.0.http,
                &github.api.parse()?,
                &github.repository,
                permissions,
            )
            .await?;
        Ok((token.token.expose().to_owned(), token.repository_id))
    }

    /// A private scratch directory and the settings that reach `remote` from it.
    pub(crate) fn session(&self, remote: &Remote) -> Result<Session> {
        let directory = tempfile::Builder::new()
            .prefix(SCRATCH_PREFIX)
            .tempdir_in(&self.0.directory)?;
        let private = directory.path().join("credential");
        std::fs::DirBuilder::new().mode(0o700).create(&private)?;
        let settings = match (&remote.credential, remote.transport) {
            (Some(_), transport) if remote.minted.is_some() => Credential::HttpsToken {
                username: "x-access-token".into(),
                token: remote.minted.clone().unwrap_or_default(),
            }
            .settings(transport, &private, &self.trusted_hosts())?,
            (Some((_, credential)), transport) => {
                credential.settings(transport, &private, &self.trusted_hosts())?
            }
            (None, RemoteTransport::Ssh) => {
                credentials::anonymous_ssh(&private, &self.trusted_hosts())
            }
            (None, _) => git::Settings::default(),
        };
        Ok(Session {
            directory,
            settings,
            transport: remote.transport,
            url: remote.url.clone(),
        })
    }
}
