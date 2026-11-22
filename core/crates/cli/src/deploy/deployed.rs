//! `supertag deploy status`: what the target runs now.
//!
//! Everything here is asked of the target or of the running Control Plane: whether a
//! deployment exists, which secrets the store holds, whether the endpoint is healthy, and which
//! SuperTag release answers. This machine's files are never the answer. The committed CA file
//! is only compared with the deployment: it belongs to the deployed certificate when SuperTag's
//! TLS handshake through the endpoint succeeds with it.
use std::{path::Path, time::Duration};

use anyhow::Result;
use serde_json::json;
use supertag_protocol::{
    negotiation::{PROTOCOL_VERSIONS, build_version},
    v2::{
        NegotiateProtocolRequest, ServiceRole,
        protocol_negotiation_client::ProtocolNegotiationClient,
    },
};

use super::{
    config::Config, health_client, healthy, operator_token, store, target::Target, tls, variable_of,
};
use crate::{deployment, network};

/// An error with every cause behind it, which is where a TLS failure says what it was.
fn causes(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(error) = cause {
        text.push_str(": ");
        text.push_str(&error.to_string());
        cause = error.source();
    }
    text
}

/// Whether a failed connection says the server's certificate was not accepted.
fn refused_certificate(error: &str) -> bool {
    error.to_ascii_lowercase().contains("certificate")
}

pub(super) async fn run(config: &Config, directory: &Path, target: &dyn Target) -> Result<()> {
    target.prepare()?;
    let store = store(target)?;
    let deployment = target.deployment()?;
    let mut secrets: Vec<String> = store
        .list()?
        .iter()
        .filter_map(|secret| variable_of(secret))
        .map(|(name, _)| name)
        .collect();
    secrets.sort();

    let ca_file = config.ca_file(directory);
    let ca = ca_file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok());
    // The endpoint is the candidate that answers its health check.
    let client = health_client(ca.as_deref())?;
    let mut endpoint = None;
    let mut unhealthy = None;
    for candidate in &deployment.endpoints {
        match &candidate.health {
            Some(health) => match healthy(&client, health).await {
                Ok(()) => {
                    endpoint = Some(candidate);
                    break;
                }
                Err(answer) => unhealthy = Some(format!("{health} gave {answer}")),
            },
            None => {
                endpoint = Some(candidate);
                break;
            }
        }
    }
    let mut report = json!({
        "target": target.platform().name(),
        "deployed": deployment.state.is_some(),
        "state": deployment.state,
        "endpoint": endpoint
            .or(match deployment.endpoints.as_slice() {
                [only] => Some(only),
                _ => None,
            })
            .map(|endpoint| endpoint.url.clone()),
        "healthy": endpoint.is_some(),
        "secret_store": store.describe(),
        "secrets": secrets,
        "certificate": {
            "ca_file": ca_file,
            "ca_file_present": ca.is_some(),
            "matches_deployment": null,
        },
    });
    if let (None, Some(unhealthy)) = (endpoint, unhealthy) {
        report["health"] = unhealthy.into();
    }

    if let (Some(_), Some(file), None) = (endpoint, &ca_file, &ca) {
        // Without the file there is nothing to compare; that is not a mismatch.
        report["certificate"]["error"] = format!(
            "{} is missing, so SuperTag's TLS could not be checked",
            file.display()
        )
        .into();
    } else if let Some(endpoint) = endpoint {
        let files = network::TlsFiles {
            server_ca: ca_file.clone(),
            ..Default::default()
        };
        let connection =
            network::operator_endpoint(endpoint.url.clone(), Duration::from_secs(15), Some(&files))
                .await;
        // SuperTag's own TLS, inside the platform's: the handshake succeeds only when the
        // deployed certificate chains to the CA file.
        let handshake = match &connection {
            Ok(connection) => connection
                .connect()
                .await
                .map(|channel| (connection, channel))
                .map_err(|error| causes(&error)),
            Err(error) => Err(format!("{error:#}")),
        };
        match handshake {
            Ok((connection, channel)) => {
                if ca.is_some() {
                    report["certificate"]["matches_deployment"] = true.into();
                    // A generated authority issues one certificate, so its file's dates are
                    // the deployed certificate's.
                    if let Some(days) = ca.as_deref().and_then(tls::days_left) {
                        report["certificate"]["ends_in_days"] = days.into();
                    }
                }
                let mut request = tonic::Request::new(NegotiateProtocolRequest {
                    role: ServiceRole::Client as i32,
                    protocol_versions: PROTOCOL_VERSIONS.to_vec(),
                    build_version: build_version().into(),
                });
                request.set_timeout(Duration::from_secs(15));
                if let Ok(answer) = ProtocolNegotiationClient::new(channel)
                    .negotiate(request)
                    .await
                {
                    report["version"] = answer.into_inner().build_version.into();
                }
                // `supertag verify deployment`'s checks, with the Operator Token when this
                // machine or the environment has one.
                let token = operator_token(target, store)?;
                let token = token.as_ref().map(|(token, _)| token.as_str());
                let verified = match network::operator_channel(connection).await {
                    Ok(channel) => deployment::verify_channel(channel, token, false).await,
                    Err(error) => Err(error),
                };
                match verified {
                    Ok(passed) => report["verification"] = passed.trim().into(),
                    Err(error) => report["verification_failed"] = format!("{error:#}").into(),
                }
            }
            Err(error) => {
                // Only a refused certificate is a mismatch; any other failure leaves the
                // question open.
                if ca_file.is_some() && refused_certificate(&error) {
                    report["certificate"]["matches_deployment"] = false.into();
                }
                report["certificate"]["error"] = error.into();
            }
        }
    }
    crate::terminal::print_json_pretty(&report)?;
    Ok(())
}
