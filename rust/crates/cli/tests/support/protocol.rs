//! Negotiated test channels. The Control Plane refuses every call that does not
//! name a negotiated protocol version, so a test that calls a running service
//! directly negotiates first, as an operator client.
#![allow(dead_code)]

use anyhow::{Context, Result};
use supertag_protocol::{
    negotiation::{PROTOCOL_VERSIONS, ProtocolChannel, bind, build_version},
    v2::{
        NegotiateProtocolRequest, ServiceRole,
        protocol_negotiation_client::ProtocolNegotiationClient,
    },
};
use tonic::{
    Code,
    transport::{Channel, Endpoint},
};

/// Negotiates on `channel` and returns it bound to the selected version, as an
/// operator client or, where only Gateways are accepted, as a Gateway.
pub async fn negotiated(channel: Channel) -> Result<ProtocolChannel> {
    let mut client = ProtocolNegotiationClient::new(channel.clone());
    let offer = |role: ServiceRole| NegotiateProtocolRequest {
        role: role as i32,
        protocol_versions: PROTOCOL_VERSIONS.to_vec(),
        build_version: build_version().into(),
    };
    let answer = match client.negotiate(offer(ServiceRole::Operator)).await {
        Err(status) if status.code() == Code::PermissionDenied => {
            client.negotiate(offer(ServiceRole::Gateway)).await
        }
        answer => answer,
    }
    .context("negotiate the SuperTag protocol")?
    .into_inner();
    Ok(bind(channel, answer.protocol_version))
}

/// Connects to `url` and negotiates.
pub async fn dial(url: impl Into<String>) -> Result<ProtocolChannel> {
    negotiated(Endpoint::from_shared(url.into())?.connect().await?).await
}
