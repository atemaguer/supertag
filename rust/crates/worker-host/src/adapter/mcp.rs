use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        ApprovalState, CallHarnessMcpToolRequest, CallHarnessMcpToolResponse,
        HarnessMcpApprovalState, ListHarnessMcpToolsRequest, ListHarnessMcpToolsResponse,
        ReserveMcpEffectRequest, ReserveMcpEffectResponse, SettleMcpEffectRequest,
        harness_mcp_server::{HarnessMcp, HarnessMcpServer},
    },
};
use tokio::time::{self, Instant};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::mcp::{AdmittedCall, AttemptMcp};

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
        let admitted = mcp.authorize(task, &input.server, &input.tool, &input.arguments_json)?;
        let (_, cancelled) = self.inputs.authority();
        let initial_deadline = self
            .inputs
            .active_deadline()?
            .min(Instant::now() + Duration::from_secs(12));
        let effect = async {
            // Complete shares this lane. Other Harness traffic can continue while the provider runs.
            let _lane = self.mcp_lane.lock().await;
            if self.state.lock().await.outcome.is_some() {
                return Err(Status::failed_precondition(
                    "MCP execution has already completed",
                ));
            }
            let active_until = self.inputs.active_deadline()?.min(initial_deadline);
            self.call_mcp(mcp, input, admitted, active_until)
                .await
                .map(Response::new)
        };
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err(Status::cancelled("MCP execution authority ended")),
            response = time::timeout_at(initial_deadline, effect) => response
                .map_err(|_| Status::deadline_exceeded("MCP request exceeded its execution deadline"))?,
        }
    }
}

impl Bridge {
    async fn call_mcp(
        &self,
        mcp: &AttemptMcp,
        mut input: CallHarnessMcpToolRequest,
        admitted: AdmittedCall,
        deadline: Instant,
    ) -> Result<CallHarnessMcpToolResponse, Status> {
        if input.operation_id.is_empty() && !admitted.requires_approval {
            input.operation_id = Uuid::new_v4().to_string();
        }
        if input.operation_id.is_empty() || input.operation_id.len() > 256 {
            return Err(Status::invalid_argument(
                "MCP approval requires an operation ID",
            ));
        }
        let sent = Instant::now();
        let mut reserve = authenticated_request(
            ReserveMcpEffectRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id.clone(),
                server: input.server.clone(),
                tool: input.tool.clone(),
                arguments_json: input.arguments_json,
                provider_binding: admitted.provider_binding,
                tool_schema_sha256: admitted.tool_schema_sha256,
            },
            &self.host_token,
            None,
        )?;
        reserve.set_timeout(
            deadline
                .saturating_duration_since(sent)
                .min(Duration::from_secs(2)),
        );
        let mut effects = self.coordination.mcp_effects.clone();
        let reserved = effects.reserve(reserve).await?.into_inner();
        if reserved.ungated {
            if admitted.requires_approval
                || reserved.approval.is_some()
                || reserved.unconfirmed
                || reserved.dispatch_id.is_some()
                || reserved.result_json.is_some()
            {
                return Err(Status::data_loss(
                    "MCP dispatch omitted a required approval",
                ));
            }
            let (arguments, until) = dispatch_arguments(&reserved, sent, deadline)?;
            self.inputs.active_deadline()?;
            if Instant::now() >= until {
                return Err(Status::failed_precondition(
                    "MCP execution authority ended before dispatch",
                ));
            }
            let result_json =
                time::timeout_at(until, mcp.call(&input.server, &input.tool, arguments))
                    .await
                    .map_err(|_| {
                        Status::deadline_exceeded("MCP provider did not confirm the request")
                    })??;
            return Ok(CallHarnessMcpToolResponse {
                result_json,
                ..Default::default()
            });
        }
        let dispatch = reserved
            .dispatch_id
            .as_ref()
            .map(|_| dispatch_arguments(&reserved, sent, deadline))
            .transpose()?;
        let approval = reserved
            .approval
            .ok_or_else(|| Status::data_loss("MCP approval receipt is missing"))?;
        if approval.action != format!("mcp:{}/{}", input.server, input.tool) {
            return Err(Status::data_loss(
                "MCP approval receipt does not match the tool",
            ));
        }
        let state = match approval.state() {
            ApprovalState::Pending => {
                if approval.task_id != self.task_id()
                    || approval.attempt_id != self.assignment.attempt_id
                    || reserved.dispatch_id.is_some()
                    || reserved.result_json.is_some()
                {
                    return Err(Status::data_loss(
                        "MCP approval receipt is outside this Attempt",
                    ));
                }
                self.state
                    .lock()
                    .await
                    .observed_approvals
                    .insert(approval.approval_id.clone());
                HarnessMcpApprovalState::Pending
            }
            ApprovalState::Denied | ApprovalState::Expired => HarnessMcpApprovalState::Denied,
            ApprovalState::Approved => HarnessMcpApprovalState::Granted,
            _ => return Err(Status::data_loss("MCP approval receipt is invalid")),
        };
        let mut response = CallHarnessMcpToolResponse {
            result_json: reserved.result_json.unwrap_or_default(),
            approval_id: Some(approval.approval_id),
            approval_state: state as i32,
        };
        let Some(dispatch_id) = reserved.dispatch_id else {
            return Ok(response);
        };
        if state != HarnessMcpApprovalState::Granted
            || !response.result_json.is_empty()
            || reserved.unconfirmed
        {
            return Err(Status::data_loss("MCP dispatch receipt is invalid"));
        }
        let (arguments, authorized_until) = dispatch.expect("validated dispatch identity");
        let provider_deadline = authorized_until.min(deadline - Duration::from_millis(500));
        let result = if self.inputs.active_deadline().is_ok() && Instant::now() < provider_deadline
        {
            time::timeout_at(
                provider_deadline,
                mcp.call(&input.server, &input.tool, arguments),
            )
            .await
            .ok()
            .and_then(Result::ok)
        } else {
            None
        };
        let mut settle = authenticated_request(
            SettleMcpEffectRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                dispatch_id,
                result_json: result.clone(),
            },
            &self.host_token,
            None,
        )?;
        settle.set_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2)),
        );
        if effects.settle(settle).await.is_ok() {
            response.result_json = result.unwrap_or_default();
        }
        Ok(response)
    }
}

fn dispatch_arguments(
    response: &ReserveMcpEffectResponse,
    sent: Instant,
    deadline: Instant,
) -> Result<(serde_json::Value, Instant), Status> {
    if !(1..=12_000).contains(&response.dispatch_valid_for_ms) {
        return Err(Status::data_loss(
            "MCP dispatch authority duration is invalid",
        ));
    }
    let arguments = response
        .canonical_arguments_json
        .as_deref()
        .and_then(|arguments| serde_json::from_str::<serde_json::Value>(arguments).ok())
        .filter(serde_json::Value::is_object)
        .ok_or_else(|| Status::data_loss("MCP dispatch canonical arguments are missing"))?;
    Ok((
        arguments,
        deadline.min(sent + Duration::from_millis(response.dispatch_valid_for_ms)),
    ))
}
