//! `supertag deploy status`: what the target runs now.
//!
//! Everything here is asked of the target or of the running Control Plane: whether a
//! deployment exists, which secrets the store holds, whether the endpoint is healthy, and which
//! SuperTag release answers. This machine's files are never the answer. The committed CA file
//! is only compared with the deployment: it belongs to the deployed certificate when SuperTag's
//! TLS handshake through the endpoint succeeds with it.
use std::{net::IpAddr, path::Path, time::Duration};

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
    certificate_names,
    config::Config,
    health_client, healthy, operator_token, store,
    target::{Endpoint, Target},
    tls, variable_of,
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

/// Where to ask for the deployment: first the hosts the CA file says the deployed certificate
/// names, then the hosts the target predicts.
///
/// A platform may give the endpoint a host this machine cannot predict, such as the regional
/// `WORKSPACE--LABEL.us-east.modal.run`. The rollout reported it and the certificate was issued
/// for it, so the CA file names it. The file only says where to ask; the deployment answers.
fn candidates(target: &dyn Target, ca: Option<&str>, predicted: Vec<Endpoint>) -> Vec<Endpoint> {
    // The name the Gateway dials inside the deployment is not the endpoint.
    let inside = certificate_names(target, Vec::new());
    let mut candidates: Vec<Endpoint> = ca
        .and_then(tls::names)
        .unwrap_or_default()
        .iter()
        .filter(|name| name.parse::<IpAddr>().is_err() && !inside.contains(name))
        .map(|name| target.endpoint_at(name))
        .collect();
    for endpoint in predicted {
        if !candidates.contains(&endpoint) {
            candidates.push(endpoint);
        }
    }
    candidates
}

pub(super) async fn run(config: &Config, directory: &Path, target: &dyn Target) -> Result<()> {
    target.prepare()?;
    let store = store(target)?;
    let mut deployment = target.deployment()?;
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
    deployment.endpoints = candidates(target, ca.as_deref(), deployment.endpoints);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::modal::Modal;

    #[test]
    fn the_host_the_certificate_names_is_asked_before_the_predicted_one() -> Result<()> {
        let target = Modal::new(None)?;
        let predicted = || vec![target.endpoint_at("acme--supertag.modal.run")];
        let urls = |ca: Option<&str>| -> Vec<String> {
            candidates(&target, ca, predicted())
                .into_iter()
                .map(|endpoint| endpoint.url)
                .collect()
        };
        // A regional host the rollout reported, and the address the Gateway dials inside.
        let regional = tls::issue(&[
            "acme--supertag.us-east.modal.run".to_owned(),
            "127.0.0.1".to_owned(),
        ])?;
        assert_eq!(
            urls(Some(&regional.ca)),
            [
                "wss://acme--supertag.us-east.modal.run",
                "wss://acme--supertag.modal.run"
            ]
        );
        // The predicted host, once.
        let predicted_host = tls::issue(&["acme--supertag.modal.run".to_owned()])?;
        assert_eq!(
            urls(Some(&predicted_host.ca)),
            ["wss://acme--supertag.modal.run"]
        );
        // No CA file, or one deploy did not write: only what the target predicts.
        assert_eq!(urls(None), ["wss://acme--supertag.modal.run"]);
        assert_eq!(
            urls(Some("-----BEGIN CERTIFICATE-----\n")),
            ["wss://acme--supertag.modal.run"]
        );
        Ok(())
    }
}
