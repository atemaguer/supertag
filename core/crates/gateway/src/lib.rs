//! The Gateway: collaboration surfaces for SuperTag.
//!
//! A Gateway receives surface events (webhooks and outbound connections), normalizes them,
//! renders and delivers replies, and sends operator notifications. It holds the surface
//! credentials, from the environment or its credential vault, and is an ordinary client of the
//! Control Plane: it calls the Connector, reply progress, and operator notification RPCs on the
//! Control Plane's public endpoint. It serves no operator or Worker Host API; its only gRPC
//! service is the operator's test notification.

mod delivery_journal;
pub mod github;
pub mod lark;
pub mod linear;
pub mod microsoft_teams;
pub mod notifications;
pub mod operator_auth;
mod ownership;
pub mod slack;
pub mod surface_setup;

/// Whether the Control Plane settled an event it will never admit: a redelivery of the same
/// event with other content, or malformed input. Retrying cannot change the answer, so the
/// Gateway acknowledges it to the provider and notes it, because it means a provider bug or
/// tampering. Refusals a person should hear about are already answered in the thread.
pub(crate) fn settled_without_admission(surface: &str, error: &tonic::Status) -> bool {
    let settled = matches!(
        error.code(),
        tonic::Code::AlreadyExists | tonic::Code::InvalidArgument
    );
    if settled {
        // The reason can echo provider input, so control characters are dropped before it
        // reaches the log.
        let reason: String = error
            .message()
            .chars()
            .filter(|c| !c.is_control())
            .take(300)
            .collect();
        // Standard error reaches only the Gateway log.
        // terminal-safe: control characters are removed above.
        eprintln!("{surface} event acknowledged without admission: {reason}");
    }
    settled
}
