//! The presence report of a Worker Host whose Worklet runs several harnesses, or several
//! concurrent Attempts of one: one report under the host's one registration, with the pool its
//! harnesses share and what each of them may run within it.

use supertag_protocol::v2::{
    HarnessExecutionProfile, HarnessKind, HostHarnessCapacity, HostReadiness, HostReadinessReason,
    ReportHostRequest,
};

use crate::worklet::readiness::{Hold, SlotState, State};

/// One harness profile a Worklet serves, and its own limit within the pool, if any.
#[derive(Clone, Debug)]
pub(crate) struct HarnessSlots {
    pub(crate) harness: HarnessKind,
    pub(crate) profile: HarnessExecutionProfile,
    pub(crate) limit: Option<u32>,
}

/// The host's report from the pool's size and each slot's latest state. A slot's harness is an
/// index into `harnesses`.
///
/// The host's capacity is the pool, or less when the harnesses' own limits add up to less. Its
/// available slots are the slots free to claim, as far as the pool and the limits leave room
/// for the Attempts running. Each harness reports its limit and the slots it could start now.
pub(crate) fn aggregate(
    sequence: u64,
    (total, harnesses): (u32, &[HarnessSlots]),
    slots: &[SlotState],
    workspaces: &[String],
) -> ReportHostRequest {
    let any = |wanted: State| slots.iter().any(|slot| slot.state == wanted);
    let (readiness, reason) = if any(State::Ready) || any(State::Busy) {
        (HostReadiness::Ready, HostReadinessReason::Unspecified)
    } else if any(State::Recovery) {
        (
            HostReadiness::Suppressed,
            HostReadinessReason::RecoveryRequired,
        )
    } else if !slots.is_empty() && slots.iter().all(|slot| slot.state == State::Stopping) {
        (HostReadiness::Suppressed, HostReadinessReason::Stopping)
    } else {
        (HostReadiness::Pending, HostReadinessReason::Starting)
    };
    let count = |matches: &dyn Fn(&SlotState) -> bool| -> u32 {
        slots.iter().filter(|slot| matches(slot)).count() as u32
    };
    let running = |slot: &SlotState| matches!(slot.held, Some((_, Hold::Attempt)));
    let limit = |harness: &HarnessSlots| harness.limit.map_or(total, |limit| limit.min(total));
    let room: Vec<u32> = harnesses
        .iter()
        .enumerate()
        .map(|(index, harness)| {
            limit(harness).saturating_sub(count(&|slot| {
                running(slot) && slot.held.is_some_and(|(held, _)| held == index)
            }))
        })
        .collect();
    let available = if readiness == HostReadiness::Ready {
        count(&|slot| slot.state == State::Ready && !running(slot))
            .min(total.saturating_sub(count(&running)))
            .min(room.iter().sum())
    } else {
        0
    };
    let entries = harnesses
        .iter()
        .zip(&room)
        .map(|(harness, room)| HostHarnessCapacity {
            harness_kind: harness.harness as i32,
            execution_profile: Some(harness.profile.clone()),
            capacity: limit(harness),
            available_slots: (*room).min(available),
        })
        .collect::<Vec<_>>();
    let (harness_kind, execution_profile) = match harnesses {
        [single] => (single.harness as i32, Some(single.profile.clone())),
        _ => (HarnessKind::Unspecified as i32, None),
    };
    ReportHostRequest {
        sequence,
        capacity: total.min(entries.iter().map(|entry| entry.capacity).sum()),
        available_slots: available,
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

    fn harness(harness: HarnessKind, limit: Option<u32>) -> HarnessSlots {
        HarnessSlots {
            harness,
            profile: HarnessExecutionProfile::default(),
            limit,
        }
    }

    fn slot(held: Option<(usize, Hold)>, state: State) -> SlotState {
        SlotState { held, state }
    }

    fn harness_slots(report: &ReportHostRequest) -> Vec<(u32, u32)> {
        report
            .harnesses
            .iter()
            .map(|entry| (entry.capacity, entry.available_slots))
            .collect()
    }

    #[test]
    fn harnesses_share_one_pool_in_the_host_report() {
        let harnesses = [
            harness(HarnessKind::Codex, None),
            harness(HarnessKind::OpenaiAgents, Some(1)),
        ];
        // Three slots: one runs Codex, one claims for Codex, one claims for OpenAI Agents.
        let report = aggregate(
            7,
            (3, &harnesses),
            &[
                slot(Some((0, Hold::Attempt)), State::Busy),
                slot(Some((0, Hold::Claim)), State::Ready),
                slot(Some((1, Hold::Claim)), State::Ready),
            ],
            &[],
        );
        assert_eq!(report.readiness(), HostReadiness::Ready);
        // The host's capacity is the pool, not the sum of its harnesses.
        assert_eq!((report.capacity, report.available_slots), (3, 2));
        assert_eq!(report.harness_kind(), HarnessKind::Unspecified);
        assert!(report.execution_profile.is_none());
        // A claim held for one harness is room for another: Codex can start both free slots.
        assert_eq!(harness_slots(&report), [(3, 2), (1, 1)]);

        // An idle harness's share goes to the other: Codex runs all three.
        let full = aggregate(
            8,
            (3, &harnesses),
            &[
                slot(Some((0, Hold::Attempt)), State::Busy),
                slot(Some((0, Hold::Attempt)), State::Busy),
                slot(Some((0, Hold::Attempt)), State::Busy),
            ],
            &[],
        );
        assert_eq!((full.capacity, full.available_slots), (3, 0));
        assert_eq!(harness_slots(&full), [(3, 0), (1, 0)]);

        // A harness at its own limit has no room while the pool still has some.
        let limited = aggregate(
            9,
            (3, &harnesses),
            &[
                slot(Some((1, Hold::Attempt)), State::Busy),
                slot(Some((0, Hold::Claim)), State::Ready),
                slot(None, State::Ready),
            ],
            &[],
        );
        assert_eq!(limited.available_slots, 2);
        assert_eq!(harness_slots(&limited), [(3, 2), (1, 0)]);

        // Limits that add up to less than the pool are the host's capacity.
        let small = [harness(HarnessKind::Codex, Some(1))];
        let single = aggregate(
            10,
            (3, &small),
            &[slot(None, State::Ready), slot(None, State::Ready)],
            &[],
        );
        assert_eq!((single.capacity, single.available_slots), (1, 1));
        assert_eq!(single.harness_kind(), HarnessKind::Codex);

        // Running Attempts beyond a lowered pool leave none free.
        let lowered = aggregate(
            11,
            (1, &harnesses),
            &[
                slot(None, State::Ready),
                slot(Some((0, Hold::Attempt)), State::Busy),
                slot(Some((1, Hold::Attempt)), State::Busy),
            ],
            &[],
        );
        assert_eq!((lowered.capacity, lowered.available_slots), (1, 0));
    }

    #[test]
    fn slot_states_set_the_host_readiness() {
        let harnesses = [
            harness(HarnessKind::Codex, None),
            harness(HarnessKind::OpenaiAgents, None),
        ];
        let recovery = aggregate(
            8,
            (2, &harnesses[..1]),
            &[slot(Some((0, Hold::Attempt)), State::Recovery)],
            &[],
        );
        assert_eq!(recovery.readiness(), HostReadiness::Suppressed);
        assert_eq!(recovery.reason(), HostReadinessReason::RecoveryRequired);
        assert_eq!(recovery.harness_kind(), HarnessKind::Codex);
        assert_eq!(recovery.available_slots, 0);

        let starting = aggregate(9, (2, &harnesses), &[slot(None, State::Pending)], &[]);
        assert_eq!(starting.readiness(), HostReadiness::Pending);
        assert_eq!(starting.available_slots, 0);
        let stopping = aggregate(
            10,
            (2, &harnesses),
            &[slot(None, State::Stopping), slot(None, State::Stopping)],
            &[],
        );
        assert_eq!(stopping.reason(), HostReadinessReason::Stopping);
    }
}
