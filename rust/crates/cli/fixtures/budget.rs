use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    authenticated_request,
    v2::{
        harness_client::HarnessClient, harness_work_sessions_client::HarnessWorkSessionsClient, *,
    },
};
use tonic::{Code, transport::Channel};

pub async fn exercise(
    bootstrap: &AdapterBootstrap,
    task: &Task,
    harness: &mut HarnessClient<Channel>,
) -> Result<()> {
    let Some(phase) =
        std::env::args().find_map(|arg| arg.strip_prefix("--budget-phase=").map(str::to_owned))
    else {
        return Ok(());
    };
    let (allocation, cost, next) = match phase.as_str() {
        "owner" => (1000, 0, Some(("first", "Measure 600 minor units", true))),
        "first" => (1000, 600, None),
        "first-report" => (400, 0, Some(("second", "Measure 380 minor units", true))),
        "second" => (400, 380, None),
        "warning" => {
            ensure!(task.prompt.contains("Provider-reported spend reached 90%"));
            (20, 0, None)
        }
        "second-report" => (
            20,
            0,
            Some(("below-floor", "Do not admit this Task", false)),
        ),
        _ => anyhow::bail!("unknown budget fixture phase"),
    };
    let limits = task
        .execution_limits
        .as_ref()
        .context("accepted execution limits")?;
    ensure!(
        limits.max_reported_cost
            == Some(ReportedCostLimit {
                currency: "USD".into(),
                amount_minor: allocation
            }),
        "expected an allocation of {allocation}, got {limits:?}"
    );
    let receipt = AppliedExecutionLimits {
        limits: Some(limits.clone()),
        reported_cost: ExecutionLimitEnforcement::ProviderBudget.into(),
        ..Default::default()
    };
    harness
        .confirm_execution_limits(authenticated_request(
            receipt.clone(),
            &bootstrap.token,
            None,
        )?)
        .await?;
    harness
        .confirm_execution_limits(authenticated_request(receipt, &bootstrap.token, None)?)
        .await?;
    let usage = HarnessUsageRequest {
        sequence: 1,
        native_usage: Some(NativeTokenUsage {
            input_tokens: 21,
            cached_input_tokens: 3,
            output_tokens: 9,
            total_tokens: Some(30),
            observed_model: Some("fixture-budget-model".into()),
        }),
        amount_minor: Some(cost),
        currency: Some("USD".into()),
        estimated: false,
    };
    harness
        .report_usage(authenticated_request(
            usage.clone(),
            &bootstrap.token,
            None,
        )?)
        .await?;
    harness
        .report_usage(authenticated_request(usage, &bootstrap.token, None)?)
        .await?;
    if let Some((title, instruction, allowed)) = next {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        let request = HarnessStartWorkSessionRequest {
            operation_id: format!("budget:{phase}"),
            title: title.into(),
            instruction: instruction.into(),
            ..Default::default()
        };
        let response = work
            .start(authenticated_request(request, &bootstrap.token, None)?)
            .await;
        if allowed {
            ensure!(response?.into_inner().parent_session_id == task.session_id);
        } else {
            let error = response.expect_err("remaining Objective budget is below the floor");
            ensure!(error.code() == Code::FailedPrecondition, "{error}");
        }
    }
    Ok(())
}
