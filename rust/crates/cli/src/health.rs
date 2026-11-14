use std::time::Duration;

use anyhow::{Context, Result, ensure};
use clap::Args;
use supertag_protocol::MAX_MESSAGE_BYTES;
use tonic_health::pb::{
    HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
};

/// Read a gRPC service's declared health using the normal TLS trust configuration.
#[derive(Args)]
pub(crate) struct HealthArgs {
    /// Control Plane or Gateway endpoint.
    #[arg(long)]
    endpoint: String,
    /// Fully qualified gRPC service name; an empty string checks overall server status.
    #[arg(long, default_value = "supertag.runtime.v2.Operator")]
    service: String,
    /// Bound the entire connection and health request.
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u64).range(1..=30))]
    timeout_seconds: u64,
}

pub(crate) async fn run(args: HealthArgs) -> Result<()> {
    ensure!(
        args.service.len() <= 256
            && args
                .service
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_'),
        "invalid gRPC service name"
    );
    let status = tokio::time::timeout(Duration::from_secs(args.timeout_seconds), async {
        // Health is a read-only standard gRPC service. TLS/mTLS trust is still
        // required; no operator, host, or service bearer credential is needed.
        let channel = crate::network::endpoint(args.endpoint)
            .await?
            .connect()
            .await?;
        let response = HealthClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .check(HealthCheckRequest {
                service: args.service.clone(),
            })
            .await?
            .into_inner();
        ServingStatus::try_from(response.status).context("unknown gRPC health status")
    })
    .await
    .context("gRPC health check timed out")??;
    ensure!(
        status == ServingStatus::Serving,
        "gRPC service is {}",
        status.as_str_name()
    );
    crate::terminal::print_json(
        &serde_json::json!({"service": args.service, "status": status.as_str_name()}),
    )?;
    Ok(())
}
