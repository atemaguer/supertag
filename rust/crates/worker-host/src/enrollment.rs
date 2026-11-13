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
    MAX_MESSAGE_BYTES,
    v2::{
        EnrollHostRequest, HostRecord, ServiceRole, host_enrollment_client::HostEnrollmentClient,
    },
};
use supertag_transport::Target;
use uuid::Uuid;

use crate::{journal::Journal, request};

#[derive(Deserialize, Serialize)]
struct Enrollment {
    gateway: String,
    host_id: String,
    operation_id: String,
    token: String,
    receipt: Option<Receipt>,
    /// The ID the Control Plane enrolled when a reusable Auth Key found `host_id` taken and
    /// suffixed it, as `NAME-2`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enrolled_host_id: Option<String>,
    /// A replacement credential recorded before the Control Plane was asked to install it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rotation: Option<PendingRotation>,
}

/// A Worker Host credential rotation that this state directory has not yet finished.
#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
pub struct PendingRotation {
    pub host_id: String,
    pub token: String,
    pub expected_revision: u64,
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    generation: u64,
}

pub async fn enroll(
    gateway: Target,
    directory: &Path,
    host_id: String,
    auth_key: Option<&str>,
) -> Result<HostRecord> {
    let journal = Journal::open(directory)?;
    let mut state = match read(&journal)? {
        Some(state) => state,
        None => Enrollment {
            gateway: gateway.url(),
            host_id: host_id.clone(),
            operation_id: Uuid::new_v4().to_string(),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            receipt: None,
            enrolled_host_id: None,
            rotation: None,
        },
    };
    ensure!(
        state.gateway == gateway.url() && state.host_id == host_id,
        "Worker Host state belongs to another enrollment"
    );
    if let Some(receipt) = &state.receipt {
        return Ok(HostRecord {
            host_id: state.enrolled_id().to_owned(),
            generation: receipt.generation,
            revoked: false,
        });
    }
    let auth_key = auth_key
        .filter(|key| !key.is_empty())
        .context("Auth Key required")?;

    // Preserve the operation and candidate credential before contacting the Gateway,
    // so that a consumed key can replay the enrollment after a lost response.
    save(&journal, &state)?;
    let channel = supertag_protocol::negotiation::connect(
        gateway.connect_lazy(),
        ServiceRole::WorkerHost,
        ServiceRole::Gateway,
    )
    .await?;
    let mut enrollment = HostEnrollmentClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let record = enrollment
        .enroll_host(request(
            EnrollHostRequest {
                host_id: state.host_id.clone(),
                operation_id: state.operation_id.clone(),
                token_digest: Sha256::digest(state.token.as_bytes()).to_vec(),
            },
            auth_key,
        )?)
        .await?
        .into_inner();
    ensure!(
        !record.revoked && suffixed_or_same(&record.host_id, &state.host_id),
        "invalid Worker Host enrollment receipt"
    );
    if record.host_id != state.host_id {
        state.enrolled_host_id = Some(record.host_id.clone());
    }
    state.receipt = Some(Receipt {
        generation: record.generation,
    });
    save(&journal, &state)?;
    Ok(record)
}

impl Enrollment {
    /// The Worker Host ID this state directory is enrolled as.
    fn enrolled_id(&self) -> &str {
        self.enrolled_host_id.as_deref().unwrap_or(&self.host_id)
    }
}

/// Whether `enrolled` is `requested` or `requested-N` with N of 2 or more.
fn suffixed_or_same(enrolled: &str, requested: &str) -> bool {
    enrolled == requested
        || enrolled
            .strip_prefix(requested)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|number| {
                !number.starts_with('0') && number.parse::<u32>().is_ok_and(|number| number >= 2)
            })
}

pub(crate) fn host_token(journal: &Journal, gateway: &Target) -> Result<String> {
    let state = read(journal)?.context("enroll this Worker Host first")?;
    ensure!(
        state.gateway == gateway.url(),
        "Worker Host state belongs to another Gateway endpoint"
    );
    ensure!(
        state.receipt.is_some(),
        "complete the pending Worker Host enrollment"
    );
    Ok(state.token)
}

/// Records a replacement credential for this enrolled host before the Control Plane installs it.
/// A rotation this directory already started is returned unchanged, so a retry after a lost
/// response sends the same digest and revision. Fails while a Worker Host runs from the directory.
pub fn begin_credential_rotation(
    directory: &Path,
    host_id: &str,
    current_revision: u64,
) -> Result<PendingRotation> {
    let journal = Journal::open(directory)?;
    let mut state = read(&journal)?.context("this state directory has no enrolled Worker Host")?;
    ensure!(
        state.enrolled_id() == host_id && state.receipt.is_some(),
        "this state directory holds another Worker Host's enrollment"
    );
    if let Some(pending) = &state.rotation {
        return Ok(pending.clone());
    }
    ensure!(
        current_revision > 0,
        "invalid Worker Host credential revision"
    );
    let pending = PendingRotation {
        host_id: host_id.to_owned(),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        expected_revision: current_revision,
    };
    state.rotation = Some(pending.clone());
    save(&journal, &state)?;
    Ok(pending)
}

/// Makes the installed replacement this host's credential.
pub fn finish_credential_rotation(directory: &Path, pending: &PendingRotation) -> Result<()> {
    let journal = Journal::open(directory)?;
    let mut state = read(&journal)?.context("this state directory has no enrolled Worker Host")?;
    ensure!(
        state.rotation.as_ref() == Some(pending),
        "this state directory recorded a different credential rotation"
    );
    state.token.clone_from(&pending.token);
    state.rotation = None;
    save(&journal, &state)
}

/// Forgets a replacement the Control Plane refused, so the next rotation starts afresh.
pub fn abandon_credential_rotation(directory: &Path, pending: &PendingRotation) -> Result<()> {
    let journal = Journal::open(directory)?;
    let mut state = read(&journal)?.context("this state directory has no enrolled Worker Host")?;
    if state.rotation.as_ref() == Some(pending) {
        state.rotation = None;
        save(&journal, &state)?;
    }
    Ok(())
}

fn read(journal: &Journal) -> Result<Option<Enrollment>> {
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
        "Worker Host credential file must be private"
    );
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 8192,
        "Worker Host credential file is oversized"
    );
    Ok(Some(
        serde_json::from_slice(&bytes).context("read Worker Host enrollment")?,
    ))
}

fn save(journal: &Journal, enrollment: &Enrollment) -> Result<()> {
    journal.write(&journal.directory().join("enrollment.json"), |file| {
        Ok(serde_json::to_writer(file, enrollment)?)
    })
}

#[cfg(test)]
mod tests {
    use super::suffixed_or_same;

    #[test]
    fn accepts_only_the_requested_id_or_its_numbered_suffix() {
        for enrolled in ["runner", "runner-2", "runner-10"] {
            assert!(suffixed_or_same(enrolled, "runner"), "{enrolled}");
        }
        for enrolled in [
            "runner-1",
            "runner-02",
            "runner-x",
            "runner2",
            "other",
            "runner-2-2",
        ] {
            assert!(!suffixed_or_same(enrolled, "runner"), "{enrolled}");
        }
    }
}
