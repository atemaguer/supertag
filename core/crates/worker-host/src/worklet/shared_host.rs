//! The presence report of a Worker Host whose Worklet runs several harnesses, or several
//! concurrent Attempts of one: one report under the host's one registration, with each
//! harness's capacity and free slots.

use supertag_protocol::v2::{
    HarnessExecutionProfile, HarnessKind, HostHarnessCapacity, HostReadiness, HostReadinessReason,
    ReportHostRequest,
};

use crate::worklet::readiness::State;

/// One harness profile a Worklet serves and the number of slots that run it.
#[derive(Clone, Debug)]
pub(crate) struct HarnessSlots {
    pub(crate) harness: HarnessKind,
    pub(crate) profile: HarnessExecutionProfile,
    pub(crate) capacity: u32,
}

/// The host's report from each slot's latest state. `slots` pairs an index into `harnesses`
/// with that slot's state.
pub(crate) fn aggregate(
    sequence: u64,
    harnesses: &[HarnessSlots],
    slots: &[(usize, State)],
    workspaces: &[String],
) -> ReportHostRequest {
    let ready = |index| {
        slots
            .iter()
            .filter(|(slot, state)| *slot == index && *state == State::Ready)
            .count() as u32
    };
    let any = |wanted: State| slots.iter().any(|(_, state)| *state == wanted);
    let (readiness, reason) = if any(State::Ready) || any(State::Busy) {
        (HostReadiness::Ready, HostReadinessReason::Unspecified)
    } else if any(State::Recovery) {
        (
            HostReadiness::Suppressed,
            HostReadinessReason::RecoveryRequired,
        )
    } else if !slots.is_empty() && slots.iter().all(|(_, state)| *state == State::Stopping) {
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
        ..Default::default()
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
    fn slots_aggregate_into_one_consistent_host_report() {
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
