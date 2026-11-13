//! Registration and presence shared by every execution lane of one supervised Worker Host.
//!
//! A Host that serves several harnesses, or several concurrent Attempts of one harness, runs one
//! lane process per slot. The supervisor registers the Host's single incarnation once, and each
//! lane replays that same incarnation, so the Control Plane keeps one generation for all of them.
//! A different incarnation still replaces the generation and fences every lane at once.

use std::path::Path;

use anyhow::{Result, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        HarnessExecutionProfile, HarnessKind, HostHarnessCapacity, HostReadiness,
        HostReadinessReason, RegisterHostRequest, ReportHostRequest, WorkerHostStatus,
        worker_host_client::WorkerHostClient,
    },
};
use tokio_util::sync::CancellationToken;
use tonic::{Status, transport::Endpoint};

use crate::{
    HostHeaders, RegisteredHost, enrollment, journal::Journal, readiness::State, request,
    retryable, wait_for_work,
};

/// One harness profile a Host serves and the number of lanes that run it.
#[derive(Clone, Debug)]
pub struct HarnessSlots {
    pub harness: HarnessKind,
    pub profile: HarnessExecutionProfile,
    pub capacity: u32,
}

pub struct SharedHost {
    journal: Journal,
    client: RegisteredHost,
    token: String,
    incarnation_id: String,
    generation: u64,
}

impl SharedHost {
    /// Register the Host's incarnation before any lane starts. Returns `None` on shutdown.
    pub async fn register(
        gateway: Endpoint,
        state_directory: &Path,
        shutdown: &CancellationToken,
    ) -> Result<Option<Self>> {
        let journal = Journal::open(state_directory)?;
        let token = enrollment::host_token(&journal, &gateway)?;
        let incarnation_id = journal.incarnation()?;
        let channel = gateway.connect_lazy();
        let mut registration = WorkerHostClient::new(channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        let record = loop {
            if shutdown.is_cancelled() {
                return Ok(None);
            }
            let response = registration
                .register_host(request(
                    RegisterHostRequest {
                        incarnation_id: incarnation_id.clone(),
                    },
                    &token,
                )?)
                .await;
            match response {
                Ok(response) => break response.into_inner(),
                Err(error) if retryable(&error) => wait_for_work(shutdown).await,
                Err(error) => return Err(error.into()),
            }
        };
        ensure!(
            !record.revoked && record.generation > 0,
            "Worker Host registration is inactive"
        );
        let client = WorkerHostClient::with_interceptor(
            channel,
            HostHeaders(record.generation.to_string().parse()?),
        )
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
        Ok(Some(Self {
            journal,
            client,
            token,
            incarnation_id,
            generation: record.generation,
        }))
    }

    /// The Host credential each lane presents. It never reaches a harness process.
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn incarnation_id(&self) -> &str {
        &self.incarnation_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Report the Host's presence from each lane's latest state. `lanes` pairs an index into
    /// `harnesses` with that lane's state. A fenced or revoked registration is an error.
    pub async fn report(
        &mut self,
        harnesses: &[HarnessSlots],
        lanes: &[(usize, State)],
        workspaces: &[String],
    ) -> Result<WorkerHostStatus, Status> {
        let sequence = self
            .journal
            .next_report_sequence()
            .map_err(|_| Status::internal("Host presence sequence is unavailable"))?;
        let report = aggregate(sequence, harnesses, lanes, workspaces);
        let request = request(report, &self.token)
            .map_err(|_| Status::internal("invalid Host presence request"))?;
        Ok(self.client.report_host(request).await?.into_inner())
    }
}

/// Whether a presence failure only delays the next report.
pub fn transient(error: &Status) -> bool {
    retryable(error)
}

fn aggregate(
    sequence: u64,
    harnesses: &[HarnessSlots],
    lanes: &[(usize, State)],
    workspaces: &[String],
) -> ReportHostRequest {
    let ready = |index| {
        lanes
            .iter()
            .filter(|(lane, state)| *lane == index && *state == State::Ready)
            .count() as u32
    };
    let any = |wanted: State| lanes.iter().any(|(_, state)| *state == wanted);
    let (readiness, reason) = if any(State::Ready) || any(State::Busy) {
        (HostReadiness::Ready, HostReadinessReason::Unspecified)
    } else if any(State::Recovery) {
        (
            HostReadiness::Suppressed,
            HostReadinessReason::RecoveryRequired,
        )
    } else if !lanes.is_empty() && lanes.iter().all(|(_, state)| *state == State::Stopping) {
        (HostReadiness::Suppressed, HostReadinessReason::Stopping)
    } else {
        (HostReadiness::Pending, HostReadinessReason::Starting)
    };
    let entries = harnesses
        .iter()
        .enumerate()
        .map(|(index, slots)| HostHarnessCapacity {
            harness_kind: slots.harness as i32,
            execution_profile: Some(slots.profile.clone()),
            capacity: slots.capacity,
            available_slots: if readiness == HostReadiness::Ready {
                ready(index).min(slots.capacity)
            } else {
                0
            },
        })
        .collect::<Vec<_>>();
    let (harness_kind, execution_profile) = match harnesses {
        [single] => (single.harness as i32, Some(single.profile.clone())),
        _ => (HarnessKind::Unspecified as i32, None),
    };
    ReportHostRequest {
        sequence,
        capacity: entries.iter().map(|entry| entry.capacity).sum(),
        available_slots: entries.iter().map(|entry| entry.available_slots).sum(),
        readiness: readiness as i32,
        reason: reason as i32,
        harness_kind,
        workspace_ids: workspaces.to_vec(),
        execution_profile,
        harnesses: entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots(harness: HarnessKind, capacity: u32) -> HarnessSlots {
        HarnessSlots {
            harness,
            profile: HarnessExecutionProfile::default(),
            capacity,
        }
    }

    #[test]
    fn lanes_aggregate_into_one_consistent_host_report() {
        let harnesses = [
            slots(HarnessKind::Codex, 2),
            slots(HarnessKind::OpenaiAgents, 1),
        ];
        let report = aggregate(
            7,
            &harnesses,
            &[(0, State::Ready), (0, State::Busy), (1, State::Recovery)],
            &[],
        );
        assert_eq!(report.readiness(), HostReadiness::Ready);
        assert_eq!((report.capacity, report.available_slots), (3, 1));
        assert_eq!(report.harness_kind(), HarnessKind::Unspecified);
        assert!(report.execution_profile.is_none());
        assert_eq!(report.harnesses[0].available_slots, 1);
        assert_eq!(report.harnesses[1].available_slots, 0);

        let recovery = aggregate(8, &harnesses[..1], &[(0, State::Recovery)], &[]);
        assert_eq!(recovery.readiness(), HostReadiness::Suppressed);
        assert_eq!(recovery.reason(), HostReadinessReason::RecoveryRequired);
        assert_eq!(recovery.harness_kind(), HarnessKind::Codex);
        assert_eq!(recovery.available_slots, 0);

        let starting = aggregate(9, &harnesses, &[(0, State::Pending)], &[]);
        assert_eq!(starting.readiness(), HostReadiness::Pending);
        let stopping = aggregate(
            10,
            &harnesses,
            &[(0, State::Stopping), (1, State::Stopping)],
            &[],
        );
        assert_eq!(stopping.reason(), HostReadinessReason::Stopping);
    }
}
