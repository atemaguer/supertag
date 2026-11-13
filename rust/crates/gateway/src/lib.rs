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
