//! Reports a running Attempt's changed Workspace paths for Objective overlap warnings.
//! TypeScript parity: `scanRunningAttempts` in `apps/cli/src/worker-changed-paths.ts`, which ran
//! on each host heartbeat (about 30 seconds). A failed scan or report never affects execution.
use std::time::Duration;

use supertag_protocol::{
    authenticated_request,
    changed_paths::{MAX_CHANGED_PATHS, reportable_path},
    v2::{
        InspectAttemptRequest, ReportChangedPathsRequest,
        attempt_changed_paths_client::AttemptChangedPathsClient,
    },
};
use supertag_workspaces::Checkout;
use tokio::time;
use tokio_util::sync::CancellationToken;
use tonic::{service::interceptor::InterceptedService, transport::Channel};

use crate::HostHeaders;

/// Test builds may scan more often than the default.
const INTERVAL_VARIABLE: &str = "SUPERTAG_TEST_CHANGED_PATHS_INTERVAL_MS";
const INTERVAL: Duration = Duration::from_secs(30);

fn interval() -> Duration {
    std::env::var(INTERVAL_VARIABLE)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|milliseconds| *milliseconds >= 10)
        .map_or(INTERVAL, Duration::from_millis)
}

pub(crate) async fn report(
    mut client: AttemptChangedPathsClient<InterceptedService<Channel, HostHeaders>>,
    attempt: InspectAttemptRequest,
    token: String,
    checkout: Checkout,
    stop: CancellationToken,
) {
    let interval = interval();
    let mut reported = None;
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            () = time::sleep(interval) => {}
        }
        let scan = supertag_workspaces::changed_paths(
            &checkout,
            reportable_path,
            MAX_CHANGED_PATHS,
            &stop,
        );
        let Ok(Ok(changed)) = time::timeout(Duration::from_secs(10), scan).await else {
            continue;
        };
        // An unchanged report adds nothing; another Attempt's report is compared with it.
        if reported.as_ref() == Some(&changed) {
            continue;
        }
        let Ok(mut request) = authenticated_request(
            ReportChangedPathsRequest {
                attempt: Some(attempt.clone()),
                paths: changed.0.clone(),
                truncated: changed.1,
            },
            &token,
            None,
        ) else {
            return;
        };
        request.set_timeout(Duration::from_secs(5));
        if let Ok(response) = client.report(request).await {
            reported = Some(changed);
            if !response.into_inner().compared {
                return;
            }
        }
    }
}
