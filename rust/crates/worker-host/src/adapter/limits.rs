use supertag_protocol::v2::{
    AppliedExecutionLimits, ExecutionLimitEnforcement as Enforcement, ExecutionLimits, HarnessKind,
    ReportedCostLimit,
};
use tonic::Status;

pub(super) fn bounded(limits: Option<&ExecutionLimits>) -> bool {
    limits.is_some_and(|limits| {
        limits.max_reported_tokens.is_some()
            || limits.max_reported_cost.is_some()
            || limits.max_native_agents.is_some()
    })
}

pub(super) fn verify_confirmation(
    harness: HarnessKind,
    accepted: Option<&ExecutionLimits>,
    confirmation: &AppliedExecutionLimits,
) -> Result<(), Status> {
    let (Some(accepted), Some(applied)) = (accepted, confirmation.limits.as_ref()) else {
        return Err(Status::failed_precondition(
            "no accepted execution limits to confirm",
        ));
    };
    let agrees = match (accepted.max_reported_tokens, applied.max_reported_tokens) {
        (None, None) => confirmation.reported_tokens == Enforcement::Unspecified as i32,
        (Some(limit), Some(value)) => {
            (harness == HarnessKind::Unspecified
                || (harness == HarnessKind::Codex && value <= 1_000_000))
                && value > 0
                && value <= limit
                && confirmation.reported_tokens == Enforcement::InterruptOnReport as i32
        }
        _ => false,
    } && match (&accepted.max_reported_cost, &applied.max_reported_cost) {
        (None, None) => confirmation.reported_cost == Enforcement::Unspecified as i32,
        (Some(limit), Some(value)) => {
            (harness == HarnessKind::Unspecified
                || (harness == HarnessKind::ClaudeCode
                    && limit.currency == "USD"
                    && value.amount_minor > 0))
                && limit.currency.len() == 3
                && limit.currency.bytes().all(|byte| byte.is_ascii_uppercase())
                && value.currency == limit.currency
                && value.amount_minor <= limit.amount_minor
                && value.amount_minor <= 9_007_199_254_740_991
                && confirmation.reported_cost == Enforcement::ProviderBudget as i32
        }
        _ => false,
    } && match (accepted.max_native_agents, applied.max_native_agents) {
        (None, None) => confirmation.native_agents == Enforcement::Unspecified as i32,
        (Some(limit), Some(value)) => {
            (harness == HarnessKind::Unspecified || (harness == HarnessKind::Codex && limit == 0))
                && value <= limit
                && confirmation.native_agents == Enforcement::HarnessGuard as i32
        }
        _ => false,
    };
    if !bounded(Some(applied)) || !agrees {
        return Err(Status::failed_precondition(
            "harness did not confirm the accepted execution limits",
        ));
    }
    Ok(())
}

pub(super) fn verify_success(
    accepted: Option<&ExecutionLimits>,
    applied: Option<&AppliedExecutionLimits>,
    tokens: Option<u64>,
    measured_cost: Option<&ReportedCostLimit>,
) -> Result<(), Status> {
    if !bounded(accepted) {
        return Ok(());
    }
    let limits = applied
        .and_then(|receipt| receipt.limits.as_ref())
        .ok_or_else(|| {
            Status::failed_precondition("bounded execution did not confirm its limits")
        })?;
    if let Some(limit) = limits.max_reported_tokens
        && tokens.is_none_or(|tokens| tokens >= limit)
    {
        return Err(Status::failed_precondition(
            "successful execution requires verified usage below the reported token limit",
        ));
    }
    if let Some(limit) = &limits.max_reported_cost
        && measured_cost.is_none_or(|cost| {
            cost.currency != limit.currency || cost.amount_minor > limit.amount_minor
        })
    {
        return Err(Status::failed_precondition(
            "successful execution requires verified usage within the reported cost limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_adapter_can_confirm_tighter_normalized_limits() {
        let accepted = ExecutionLimits {
            max_reported_tokens: Some(2_000_000),
            max_reported_cost: Some(ReportedCostLimit {
                currency: "EUR".into(),
                amount_minor: 50,
            }),
            max_native_agents: Some(4),
        };
        let applied = AppliedExecutionLimits {
            limits: Some(ExecutionLimits {
                max_reported_tokens: Some(1_500_000),
                max_reported_cost: Some(ReportedCostLimit {
                    currency: "EUR".into(),
                    amount_minor: 0,
                }),
                max_native_agents: Some(2),
            }),
            native_agents: Enforcement::HarnessGuard as i32,
            reported_tokens: Enforcement::InterruptOnReport as i32,
            reported_cost: Enforcement::ProviderBudget as i32,
        };
        assert!(verify_confirmation(HarnessKind::Unspecified, Some(&accepted), &applied).is_ok());
        for harness in [
            HarnessKind::Codex,
            HarnessKind::ClaudeCode,
            HarnessKind::OpenaiAgents,
            HarnessKind::Opencode,
            HarnessKind::Cursor,
        ] {
            assert!(verify_confirmation(harness, Some(&accepted), &applied).is_err());
        }
        let free = ReportedCostLimit {
            currency: "EUR".into(),
            amount_minor: 0,
        };
        assert!(verify_success(Some(&accepted), None, Some(0), Some(&free)).is_err());
        assert!(verify_success(Some(&accepted), Some(&applied), Some(1_499_999), None).is_err());
        assert!(
            verify_success(
                Some(&accepted),
                Some(&applied),
                Some(1_500_000),
                Some(&free)
            )
            .is_err()
        );
        assert!(
            verify_success(
                Some(&accepted),
                Some(&applied),
                Some(1_499_999),
                Some(&free)
            )
            .is_ok()
        );
    }
}
