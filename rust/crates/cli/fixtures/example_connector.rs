//! A minimal connector that runs as its own process, as any external surface integration does.
//! It uses only the public Connector contract on the Control Plane: protocol negotiation as a
//! Gateway, `AcceptEvent` to turn a surface event into a Task, and connector ownership with
//! `ClaimReply` and `SettleReply` to deliver the Task's reply. See
//! `docs/reference/connector-contract.md`.
//!
//! ```text
//! supertag-example-connector accept URL ACCOUNT EVENT_ID TAG SESSION CONVERSATION PROMPT
//! supertag-example-connector deliver URL ACCOUNT
//! ```
//!
//! The Gateway credential comes from `SUPERTAG_GATEWAY_TOKEN`. Each command prints one JSON line.
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use supertag_protocol::{
    authenticated_request,
    negotiation::{ProtocolChannel, connect},
    v2::{
        AcceptEventRequest, ClaimConnectorRequest, ClaimReplyRequest, ReleaseConnectorRequest,
        ReplyDestination, ReplyState, ServiceRole, SettleReplyRequest,
        connector_client::ConnectorClient,
    },
};
use tonic::{Request, transport::Endpoint};

/// The Connector client acting for `connector:ACCOUNT`.
struct Connector {
    client: ConnectorClient<ProtocolChannel>,
    token: String,
    principal: String,
}

impl Connector {
    async fn connect(url: &str, account: &str) -> Result<Self> {
        let channel = Endpoint::from_shared(url.to_owned())?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .connect()
            .await?;
        // Every call names the protocol version negotiated here.
        let channel = connect(channel, ServiceRole::Gateway, ServiceRole::ControlPlane).await?;
        Ok(Self {
            client: ConnectorClient::new(channel),
            token: std::env::var("SUPERTAG_GATEWAY_TOKEN").context("set SUPERTAG_GATEWAY_TOKEN")?,
            principal: format!("connector:{account}"),
        })
    }

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        Ok(authenticated_request(
            message,
            &self.token,
            Some(&self.principal),
        )?)
    }
}

async fn accept(url: &str, account: &str, rest: &[String]) -> Result<()> {
    let [event, tag, session, conversation, prompt] = rest else {
        bail!("accept URL ACCOUNT EVENT_ID TAG SESSION CONVERSATION PROMPT");
    };
    let mut connector = Connector::connect(url, account).await?;
    let request = connector.request(AcceptEventRequest {
        account_id: account.to_owned(),
        event_id: event.clone(),
        tag_id: tag.clone(),
        session_id: session.clone(),
        prompt: prompt.clone(),
        destination: Some(ReplyDestination {
            conversation_id: conversation.clone(),
            thread_id: None,
        }),
        requested_execution: None,
    })?;
    let task = connector.client.accept_event(request).await?.into_inner();
    println!("{}", serde_json::json!({ "task_id": task.task_id }));
    Ok(())
}

async fn deliver(url: &str, account: &str) -> Result<()> {
    let mut connector = Connector::connect(url, account).await?;
    // One owner at a time delivers an account's replies.
    let request = connector.request(ClaimConnectorRequest {
        owner_id: format!("example-{}", std::process::id()),
    })?;
    let lease = connector
        .client
        .claim_connector(request)
        .await?
        .into_inner();
    ensure!(lease.granted, "another connector owns {account}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (reply, lease_token) = loop {
        let request = connector.request(ClaimReplyRequest {
            operation_id: uuid::Uuid::new_v4().to_string(),
            connector_lease_token: lease.lease_token.clone(),
        })?;
        let claimed = connector.client.claim_reply(request).await?.into_inner();
        if let Some(reply) = claimed.reply {
            break (reply, claimed.lease_token);
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "no reply became due"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    // A real connector posts `reply.text` to its surface here, then records the receipt.
    let request = connector.request(SettleReplyRequest {
        reply_id: reply.reply_id.clone(),
        lease_token,
        state: ReplyState::Delivered as i32,
        provider_receipt: Some(format!("example-receipt-{}", reply.reply_id)),
    })?;
    let settled = connector.client.settle_reply(request).await?.into_inner();
    let request = connector.request(ReleaseConnectorRequest {
        lease_token: lease.lease_token,
    })?;
    connector.client.release_connector(request).await?;
    println!(
        "{}",
        serde_json::json!({
            "reply_id": settled.reply_id,
            "task_id": settled.task_id,
            "conversation_id": reply.destination.map(|d| d.conversation_id),
            "text": reply.text,
            "state": settled.state().as_str_name(),
        })
    );
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [command, url, account, rest @ ..] = arguments.as_slice() else {
        bail!("usage: supertag-example-connector accept|deliver URL ACCOUNT ...");
    };
    match command.as_str() {
        "accept" => accept(url, account, rest).await,
        "deliver" => deliver(url, account).await,
        other => bail!("unknown command {other}"),
    }
}
