use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        CallHarnessMcpToolRequest, CallHarnessMcpToolResponse, ListHarnessMcpToolsRequest,
        ListHarnessMcpToolsResponse, TaskState,
        harness_mcp_server::{HarnessMcp, HarnessMcpServer},
    },
};
use tokio::time::{self, Instant};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn mcp_service(&self) -> HarnessMcpServer<Self> {
        HarnessMcpServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HarnessMcp for Bridge {
    async fn list(
        &self,
        request: Request<ListHarnessMcpToolsRequest>,
    ) -> Result<Response<ListHarnessMcpToolsResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.inputs.active_deadline()?;
        Ok(Response::new(ListHarnessMcpToolsResponse {
            tools: self.mcp.as_ref().map_or_else(Vec::new, |mcp| mcp.list()),
        }))
    }

    async fn call(
        &self,
        request: Request<CallHarnessMcpToolRequest>,
    ) -> Result<Response<CallHarnessMcpToolResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mcp = self
            .mcp
            .as_ref()
            .ok_or_else(|| Status::permission_denied("Task has no admitted MCP tools"))?;
        let input = request.into_inner();
        let task = self.assignment.task.as_ref().expect("validated assignment");
        let arguments = mcp.authorize(task, &input.server, &input.tool, &input.arguments_json)?;
        let (_, cancelled) = self.inputs.authority();
        let initial_deadline = self
            .inputs
            .active_deadline()?
            .min(Instant::now() + Duration::from_secs(12));
        let effect = async {
            // Complete shares this lane. Other Harness traffic can continue while the provider runs.
            let _lane = self.mcp_lane.lock().await;
            let active_until = self.inputs.active_deadline()?.min(initial_deadline);
            let mut authority = authenticated_request(self.attempt(), &self.host_token, None)?;
            authority.set_timeout(
                active_until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_secs(2)),
            );
            let observed = self
                .host
                .clone()
                .inspect_attempt(authority)
                .await?
                .into_inner();
            if observed.state() != TaskState::Running
                || observed.task_id != task.task_id
                || observed.attempt_id.as_deref() != Some(&self.assignment.attempt_id)
                || Instant::now() >= active_until
                || cancelled.is_cancelled()
            {
                return Err(Status::failed_precondition(
                    "MCP execution authority ended before dispatch",
                ));
            }
            let result_json = time::timeout_at(
                active_until,
                mcp.call(&input.server, &input.tool, arguments),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("MCP provider did not confirm the request"))??;
            Ok(Response::new(CallHarnessMcpToolResponse { result_json }))
        };
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err(Status::cancelled("MCP execution authority ended")),
            response = time::timeout_at(initial_deadline, effect) => response
                .map_err(|_| Status::deadline_exceeded("MCP request exceeded its execution deadline"))?,
        }
    }
}
