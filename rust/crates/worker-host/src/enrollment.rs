//! A Worker Host's or Gateway's enrollment with the Control Plane, kept in its private state
//! directory. The enrollee generates its own `stcr_` credential, sends only its digest with an
//! Auth Key of its role, and from then on presents the credential as its bearer. The same state
//! records a self-rotation before the Control Plane is asked to install it, so a retry after a
//! lost response completes the same rotation instead of locking the enrollee out.

use std::{
    fs::OpenOptions,
    io::{ErrorKind, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, CREDENTIAL_SECRET_PREFIX, MAX_MESSAGE_BYTES, is_secret, new_secret,
    v2::{
        CredentialRotation, EnrollRequest, Enrollment, PrincipalRole, RotateCredentialRequest,
        ServiceRole, enrollments_client::EnrollmentsClient,
    },
};
use supertag_transport::Target;
use tonic::Code;
use uuid::Uuid;

use crate::{journal::Journal, request};

/// The roles that enroll with a state directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnrolledRole {
    Host,
    Gateway,
}

impl EnrolledRole {
    fn proto(self) -> PrincipalRole {
        match self {
            Self::Host => PrincipalRole::Host,
            Self::Gateway => PrincipalRole::Gateway,
        }
    }

    fn service(self) -> ServiceRole {
        match self {
            Self::Host => ServiceRole::WorkerHost,
            Self::Gateway => ServiceRole::Gateway,
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Gateway => "gateway",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Host => "Worker Host",
            Self::Gateway => "Gateway",
        }
    }
}

#[derive(Deserialize, Serialize)]
struct State {
    control_plane: String,
    role: EnrolledRole,
    name: String,
    operation_id: String,
    token: String,
    /// The credential revision the Control Plane holds for `token`; set once enrolled.
    revision: Option<u64>,
    /// A replacement credential recorded before the Control Plane was asked to install it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rotation: Option<PendingRotation>,
}

/// A credential rotation that this state directory has not yet finished.
#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
struct PendingRotation {
    token: String,
    expected_revision: u64,
}

/// Enrolls `role:name` with `auth_key`, or returns the enrollment this directory already holds.
/// The operation and candidate credential are saved before the Control Plane is contacted, so a
/// one-time key can replay the enrollment after a lost response.
pub async fn enroll(
    control_plane: Target,
    directory: &Path,
    role: EnrolledRole,
    name: String,
    auth_key: Option<&str>,
) -> Result<Enrollment> {
    let journal = Journal::open(directory)?;
    let mut state = match read(&journal)? {
        Some(state) => state,
        None => State {
            control_plane: control_plane.url(),
            role,
            name: name.clone(),
            operation_id: Uuid::new_v4().to_string(),
            token: new_secret(CREDENTIAL_SECRET_PREFIX),
            revision: None,
            rotation: None,
        },
    };
    ensure!(
        state.control_plane == control_plane.url() && state.role == role && state.name == name,
        "{} state belongs to another enrollment",
        role.noun()
    );
    if let Some(revision) = state.revision {
        return Ok(Enrollment {
            role: role.proto().into(),
            principal: format!("{}:{name}", role.prefix()),
            name,
            credential_revision: revision,
            ..Default::default()
        });
    }
    let auth_key = auth_key
        .filter(|key| !key.is_empty())
        .context("Auth Key required")?;
    ensure!(
        is_secret(AUTH_KEY_SECRET_PREFIX, auth_key),
        "an Auth Key starts with stak_ and has 64 hex digits"
    );
    save(&journal, &state)?;
    let channel = supertag_protocol::negotiation::connect(
        control_plane.connect_lazy(),
        role.service(),
        ServiceRole::ControlPlane,
    )
    .await?;
    let enrollment = EnrollmentsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
        .enroll(request(
            EnrollRequest {
                role: role.proto().into(),
                name: state.name.clone(),
                operation_id: state.operation_id.clone(),
                token_digest: Sha256::digest(state.token.as_bytes()).to_vec(),
            },
            auth_key,
        )?)
        .await?
        .into_inner();
    ensure!(
        enrollment.name == state.name
            && enrollment.role == role.proto() as i32
            && enrollment.revoked_at_ms.is_none()
            && enrollment.credential_revision > 0,
        "invalid enrollment receipt"
    );
    state.revision = Some(enrollment.credential_revision);
    save(&journal, &state)?;
    Ok(enrollment)
}

/// This directory's enrolled name and credential.
pub fn credential(
    directory: &Path,
    control_plane: &Target,
    role: EnrolledRole,
) -> Result<(String, String)> {
    let journal = Journal::open(directory)?;
    stored_credential(&journal, control_plane, role)
}

fn stored_credential(
    journal: &Journal,
    control_plane: &Target,
    role: EnrolledRole,
) -> Result<(String, String)> {
    let state = read(journal)?.with_context(|| format!("enroll this {} first", role.noun()))?;
    ensure!(
        state.role == role,
        "this state directory holds another role's enrollment"
    );
    ensure!(
        state.control_plane == control_plane.url(),
        "{} state belongs to another Control Plane endpoint",
        role.noun()
    );
    ensure!(
        state.revision.is_some(),
        "complete the pending {} enrollment",
        role.noun()
    );
    Ok((state.name, state.token))
}

/// The Control Plane URL this directory enrolled with.
pub fn enrolled_control_plane(directory: &Path) -> Result<String> {
    let journal = Journal::open(directory)?;
    Ok(read(&journal)?
        .context("this state directory has no enrollment")?
        .control_plane)
}

pub(crate) fn host_token(journal: &Journal, control_plane: &Target) -> Result<String> {
    Ok(stored_credential(journal, control_plane, EnrolledRole::Host)?.1)
}

/// Rotates this directory's own credential with the Control Plane, presenting the current one.
/// A rotation this directory already started is completed with the same digest and revision.
/// Run it while no Worker Host or Gateway runs from the directory.
pub async fn rotate_own_credential(
    control_plane: Target,
    directory: &Path,
    role: EnrolledRole,
) -> Result<CredentialRotation> {
    let journal = Journal::open(directory)?;
    let mut state = read(&journal)?
        .with_context(|| format!("this state directory has no enrolled {}", role.noun()))?;
    ensure!(
        state.role == role && state.control_plane == control_plane.url(),
        "this state directory holds another enrollment"
    );
    let revision = state
        .revision
        .with_context(|| format!("complete the pending {} enrollment", role.noun()))?;
    let pending = match &state.rotation {
        Some(pending) => pending.clone(),
        None => {
            let pending = PendingRotation {
                token: new_secret(CREDENTIAL_SECRET_PREFIX),
                expected_revision: revision,
            };
            state.rotation = Some(pending.clone());
            save(&journal, &state)?;
            pending
        }
    };
    let channel = supertag_protocol::negotiation::connect(
        control_plane.connect_lazy(),
        role.service(),
        ServiceRole::ControlPlane,
    )
    .await?;
    let rotate = |bearer: &str| {
        request(
            RotateCredentialRequest {
                role: role.proto().into(),
                name: String::new(),
                expected_credential_revision: pending.expected_revision,
                token_digest: Sha256::digest(pending.token.as_bytes()).to_vec(),
            },
            bearer,
        )
    };
    let mut client = EnrollmentsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // After a lost response the Control Plane already holds the replacement, so the current
    // credential is refused and the replacement completes the same rotation.
    let result = match client.rotate_credential(rotate(&state.token)?).await {
        Err(status) if status.code() == Code::Unauthenticated => {
            client.rotate_credential(rotate(&pending.token)?).await
        }
        result => result,
    };
    match result {
        Ok(response) => {
            let rotation = response.into_inner();
            state.token.clone_from(&pending.token);
            state.revision = Some(rotation.credential_revision);
            state.rotation = None;
            save(&journal, &state)?;
            Ok(rotation)
        }
        Err(status) => {
            if !matches!(
                status.code(),
                Code::Unavailable
                    | Code::DeadlineExceeded
                    | Code::Unknown
                    | Code::Cancelled
                    | Code::Unauthenticated
            ) {
                state.rotation = None;
                save(&journal, &state)?;
            }
            Err(status.into())
        }
    }
}

fn read(journal: &Journal) -> Result<Option<State>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(journal.directory().join("enrollment.json"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "enrolled credential file must be private"
    );
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 8192, "enrolled credential file is oversized");
    Ok(Some(
        serde_json::from_slice(&bytes).context("read the enrollment state")?,
    ))
}

fn save(journal: &Journal, state: &State) -> Result<()> {
    journal.write(&journal.directory().join("enrollment.json"), |file| {
        Ok(serde_json::to_writer(file, state)?)
    })
}
