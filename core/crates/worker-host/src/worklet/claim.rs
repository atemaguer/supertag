//! The Claim this Worklet journals before it asks the Control Plane for work.

use std::time::Duration;

use supertag_protocol::v2::ClaimTaskRequest;

use crate::{McpCatalog, WorkerOptions, WorkletOptions, worklet::workspaces};

pub(crate) fn claim_request(
    options: &WorkletOptions,
    worker: &WorkerOptions,
    workspaces: &workspaces::Workspaces,
    operation_id: String,
) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id,
        workspace_ids: workspaces.ids(),
        gateway_workspace_ids: workspaces.control_plane_ids(),
        harness_kind: worker.harness as i32,
        context_contracts: worker.context_catalog.supported_contracts(),
        execution_profile: Some(McpCatalog::advertised(
            &worker.execution_profile,
            &worker.mcp_catalog.lapsed_logins(),
        )),
        // `--once` answers whether there is work now; otherwise the Control Plane holds an empty
        // claim until a Task can be claimed.
        wait_ms: if options.once {
            0
        } else {
            CLAIM_WAIT.as_millis() as u32
        },
    }
}

/// How long the Control Plane may hold an empty claim. Inside the API tier's call budget.
pub(crate) const CLAIM_WAIT: Duration = Duration::from_secs(6);
