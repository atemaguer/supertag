//! Enrolled principals: `supertag gateway enroll|revoke|rotate-credential`, `supertag client
//! revoke|rotate-credential`, the enrolled-credential parts of `supertag host` and `supertag
//! connect`, and the reads behind `supertag get gateway` and `supertag get client`.
//!
//! Hosts and Gateways enroll with an Auth Key of their role and keep their own `stcr_` credential
//! in their state directory. A client is a device: `supertag connect` enrolls it with a client
//! Auth Key and saves only the resulting credential. An enrollee rotates its own credential, and
//! an operator rotates or revokes anyone's.

use std::{
    fs,
    io::Write as _,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, CREDENTIAL_SECRET_PREFIX, MAX_MESSAGE_BYTES, is_secret, new_secret,
    v2::{enrollments_client::EnrollmentsClient, *},
};
use uuid::Uuid;

use crate::{Connection, auth_keys::role_name, connect_operator, request};

fn client(channel: ProtocolChannel) -> EnrollmentsClient<ProtocolChannel> {
    EnrollmentsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// `supertag gateway enroll|revoke|rotate-credential|credential`.
#[derive(Subcommand)]
pub enum GatewayCommand {
    /// Store or delete this machine's Gateway collaboration credentials in the configured
    /// credential vault.
    Credential {
        #[command(subcommand)]
        command: crate::gateway_credentials::GatewayCredentialCommand,
    },
    /// Enroll this Gateway with a gateway Auth Key. Its own --control-plane and
    /// --state-directory name the Control Plane to enroll with and the Gateway's private state,
    /// which `supertag gateway --state-directory` then reads.
    Enroll {
        /// Control Plane URL to enroll with.
        #[arg(long)]
        control_plane: String,
        /// Private directory for this Gateway's enrolled credential.
        #[arg(long)]
        state_directory: PathBuf,
        /// The Gateway's name: it acts as gateway:NAME. Names are never reused.
        name: String,
        /// Auth Key or file:PATH. Also reads SUPERTAG_AUTH_KEY.
        #[arg(long)]
        auth_key: Option<String>,
    },
    /// Revoke a Gateway. Its credential is refused at once, and the connector accounts it served
    /// alone pass to the next Gateway that serves them.
    Revoke {
        #[command(flatten)]
        connection: Connection,
        name: String,
    },
    /// Replace a Gateway's credential: this machine's own stopped Gateway with
    /// --gateway-state-directory, or any Gateway as an operator with NAME and --out.
    RotateCredential {
        #[command(flatten)]
        connection: Connection,
        /// The Gateway to rotate as an operator.
        #[arg(required_unless_present = "gateway_state_directory")]
        name: Option<String>,
        /// Write the new credential to this new owner-only file, for a Gateway that reads
        /// SUPERTAG_GATEWAY_CREDENTIAL from its own secret manager.
        #[arg(
            long,
            required_unless_present = "gateway_state_directory",
            conflicts_with = "gateway_state_directory"
        )]
        out: Option<PathBuf>,
        /// Install the new credential in the state directory of this machine's stopped,
        /// enrolled Gateway. It uses the credential when it next starts.
        #[arg(long)]
        gateway_state_directory: Option<PathBuf>,
    },
}

/// `supertag client revoke|rotate-credential`.
#[derive(Subcommand)]
pub enum ClientCommand {
    /// Revoke a client device. Its credential is refused at once. Its history stays under its
    /// name, which is never reused.
    Revoke {
        #[command(flatten)]
        connection: Connection,
        name: String,
    },
    /// Replace a client credential: this device's own, saved under --control-plane NAME, or any
    /// client's as an operator with NAME and --out.
    RotateCredential {
        #[command(flatten)]
        connection: Connection,
        /// The client to rotate as an operator. Omit to rotate this device's saved credential.
        #[arg(requires = "out")]
        name: Option<String>,
        /// Write the new credential to this new owner-only file.
        #[arg(long, requires = "name")]
        out: Option<PathBuf>,
    },
}

// Options for `supertag get gateways` and `supertag get clients`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 100, conflicts_with = "id")]
    limit: u32,
    /// The next_cursor of the previous page.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

/// An Auth Key from `--auth-key KEY`, `--auth-key file:PATH`, or SUPERTAG_AUTH_KEY.
pub(crate) async fn auth_key(argument: Option<String>) -> Result<Option<String>> {
    let key = argument.or_else(|| std::env::var("SUPERTAG_AUTH_KEY").ok());
    Ok(match key {
        Some(key) if key.starts_with("file:") => {
            let path = key.strip_prefix("file:").expect("checked prefix");
            let contents = tokio::fs::read_to_string(path)
                .await
                .context("read Auth Key file")?;
            Some(contents.trim().to_owned())
        }
        other => other,
    })
}

/// An enrollment without its credential.
pub fn view(enrollment: &Enrollment) -> Value {
    json!({
        "principal": enrollment.principal,
        "role": role_name(enrollment.role),
        "name": enrollment.name,
        "auth_key": enrollment.auth_key_name,
        "phase": if enrollment.revoked_at_ms.is_some() { "revoked" } else { "active" },
        "credential_revision": enrollment.credential_revision,
        "allowed_tag_ids": enrollment.allowed_tag_ids,
        "all_tags": enrollment.all_tags,
        "enrolled_at_ms": enrollment.enrolled_at_ms,
        "last_used_at_ms": enrollment.last_used_at_ms,
        "revoked_at_ms": enrollment.revoked_at_ms,
    })
}

pub async fn run_gateway(command: GatewayCommand) -> Result<()> {
    let output = match command {
        GatewayCommand::Credential { command } => {
            return crate::gateway_credentials::run(command).await;
        }
        GatewayCommand::Enroll {
            control_plane,
            state_directory,
            name,
            auth_key: key,
        } => {
            let control_plane = crate::network::endpoint(control_plane).await?;
            let key = auth_key(key).await?;
            let enrollment = supertag_worker_host::enroll(
                control_plane,
                &state_directory,
                supertag_worker_host::EnrolledRole::Gateway,
                name,
                key.as_deref(),
            )
            .await?;
            json!({ "principal": enrollment.principal, "credential_revision": enrollment.credential_revision })
        }
        GatewayCommand::Revoke { connection, name } => {
            revoke(connection, PrincipalRole::Gateway, name).await?
        }
        GatewayCommand::RotateCredential {
            connection,
            name,
            out,
            gateway_state_directory,
        } => match gateway_state_directory {
            Some(directory) => {
                rotate_own(
                    &directory,
                    supertag_worker_host::EnrolledRole::Gateway,
                    name,
                )
                .await?
            }
            None => {
                let out = out.context("choose --out or --gateway-state-directory")?;
                let name = name.context("name the Gateway to rotate")?;
                rotate_other(connection, PrincipalRole::Gateway, name, &out).await?
            }
        },
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

pub async fn run_client(command: ClientCommand) -> Result<()> {
    let output = match command {
        ClientCommand::Revoke { connection, name } => {
            revoke(connection, PrincipalRole::Client, name).await?
        }
        ClientCommand::RotateCredential {
            connection,
            name: Some(name),
            out: Some(out),
        } => rotate_other(connection, PrincipalRole::Client, name, &out).await?,
        ClientCommand::RotateCredential { connection, .. } => {
            rotate_saved_client(connection).await?
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

async fn revoke(connection: Connection, role: PrincipalRole, name: String) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let enrollment = client(channel)
        .revoke_enrollment(request(
            RevokeEnrollmentRequest {
                role: role.into(),
                name,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(view(&enrollment))
}

/// Rotates the credential in an enrolled Worker Host's or Gateway's own state directory.
pub(crate) async fn rotate_own(
    directory: &Path,
    role: supertag_worker_host::EnrolledRole,
    expected_name: Option<String>,
) -> Result<Value> {
    let control_plane = supertag_worker_host::enrolled_control_plane(directory)?;
    let target = crate::network::endpoint(control_plane).await?;
    let (name, _) = supertag_worker_host::credential(directory, &target, role)?;
    if let Some(expected) = expected_name {
        ensure!(
            expected == name,
            "this state directory holds {name}'s enrollment, not {expected}'s"
        );
    }
    let rotation = supertag_worker_host::rotate_own_credential(target, directory, role).await?;
    Ok(json!({
        "principal": rotation.principal,
        "credential_revision": rotation.credential_revision,
    }))
}

/// An operator rotates another enrollee's credential and writes the new one to a new file.
pub(crate) async fn rotate_other(
    connection: Connection,
    role: PrincipalRole,
    name: String,
    out: &Path,
) -> Result<Value> {
    // Refuse an existing path before the old credential stops working.
    ensure!(
        fs::symlink_metadata(out).is_err(),
        "{} already exists; choose a new file",
        out.display()
    );
    let (channel, token) = connect_operator(connection).await?;
    let mut enrollments = client(channel);
    let current = enrollments
        .get_enrollment(request(
            GetEnrollmentRequest {
                role: role.into(),
                name: name.clone(),
            },
            &token,
        )?)
        .await?
        .into_inner()
        .credential_revision;
    let secret = new_secret(CREDENTIAL_SECRET_PREFIX);
    let rotation = enrollments
        .rotate_credential(request(
            RotateCredentialRequest {
                role: role.into(),
                name,
                expected_credential_revision: current,
                token_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            },
            &token,
        )?)
        .await?
        .into_inner();
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(out)
        .with_context(|| format!("write the new credential to {}", out.display()))?;
    file.write_all(secret.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(json!({
        "principal": rotation.principal,
        "credential_revision": rotation.credential_revision,
    }))
}

/// Rotates this device's own client credential, saved under a Control Plane name.
async fn rotate_saved_client(connection: Connection) -> Result<Value> {
    let name = connection
        .control_plane
        .clone()
        .or_else(|| crate::ROOT_CONTROL_PLANE.get().cloned())
        .filter(|name| !crate::profiles::is_url(name))
        .context(
            "name the saved Control Plane whose client credential to rotate: --control-plane NAME",
        )?;
    let saved = crate::profiles::resolve(&name)?;
    ensure!(
        is_secret(CREDENTIAL_SECRET_PREFIX, &saved.token),
        "the Control Plane saved as {name} is connected with an operator token, not a client credential"
    );
    let (channel, token) = connect_operator(connection).await?;
    let secret = new_secret(CREDENTIAL_SECRET_PREFIX);
    let rotation = client(channel.clone())
        .rotate_credential(request(
            RotateCredentialRequest {
                role: PrincipalRole::Client.into(),
                name: String::new(),
                // The presented credential names the revision it replaces.
                expected_credential_revision: 0,
                token_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            },
            &token,
        )?)
        .await;
    let rotation = match rotation {
        Ok(rotation) => rotation.into_inner(),
        Err(status) => {
            // The response may have been lost after the rotation applied: the new credential
            // then already works, and is saved.
            let applied = client(channel)
                .who_am_i(request(WhoAmIRequest {}, &secret)?)
                .await
                .is_ok();
            ensure!(applied, "the Control Plane refused the rotation: {status}");
            CredentialRotation::default()
        }
    };
    crate::profiles::replace_token(&name, &secret)?;
    Ok(json!({
        "principal": rotation.principal,
        "credential_revision": rotation.credential_revision,
        "saved_as": name,
    }))
}

/// Enrolls this device as `client:NAME` with a client Auth Key and returns its new credential.
/// The Auth Key is used once and never saved.
pub(crate) async fn enroll_client(
    channel: ProtocolChannel,
    key: &str,
    name: &str,
) -> Result<(String, Enrollment)> {
    ensure!(
        is_secret(AUTH_KEY_SECRET_PREFIX, key),
        "an Auth Key starts with stak_ and has 64 hex digits"
    );
    let secret = new_secret(CREDENTIAL_SECRET_PREFIX);
    let enrollment = client(channel)
        .enroll(request(
            EnrollRequest {
                role: PrincipalRole::Client.into(),
                name: name.to_owned(),
                operation_id: Uuid::new_v4().to_string(),
                token_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            },
            key,
        )?)
        .await
        .context("the Control Plane refused the Auth Key")?
        .into_inner();
    Ok((secret, enrollment))
}

/// This machine's host name as a client name: letters, digits, hyphens, underscores and dots.
pub(crate) fn device_name() -> Result<String> {
    let mut buffer = [0_u8; 256];
    // SAFETY: the buffer is valid for its length, and gethostname terminates or truncates.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    ensure!(result == 0, "could not read this machine's host name");
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    let name: String = String::from_utf8_lossy(&buffer[..end])
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    ensure!(
        !name.is_empty(),
        "this machine has no host name; pass --client-name"
    );
    Ok(name)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    role: PrincipalRole,
    name: String,
) -> Result<Value> {
    Ok(view(
        &client(channel)
            .get_enrollment(request(
                GetEnrollmentRequest {
                    role: role.into(),
                    name,
                },
                token,
            )?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(
    connection: Connection,
    role: PrincipalRole,
    args: ListArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_enrollments(request(
            ListEnrollmentsRequest {
                role: role.into(),
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    let key = match role {
        PrincipalRole::Gateway => "gateways",
        _ => "clients",
    };
    Ok(json!({
        key: page.enrollments.iter().map(view).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}
