//! The Control Plane relays no files: file bytes go from the Worker Host that holds them to
//! whoever reads them, through a Volume, the Workspace's git remote, or a direct peer request,
//! never through the Control Plane or its API tier.
//!
//! This test finds every RPC the Control Plane serves (on its public listener, or internally to
//! its API tier) or a Gateway serves or forwards that streams messages carrying `bytes` fields,
//! which is how a file crosses the wire, and fails if there is any. Byte streams are allowed only
//! on services a Worker Host serves to its own harness, sandbox provider, or peers.
use std::collections::{BTreeMap, BTreeSet};

use prost::Message as _;
use prost_types::{DescriptorProto, FileDescriptorSet, field_descriptor_proto::Type};
use supertag_protocol::authorization::{PEER_LOCAL, access};

/// Every message type by its fully qualified name, such as `.supertag.runtime.v2.Task`.
fn messages(set: &FileDescriptorSet) -> BTreeMap<String, &DescriptorProto> {
    fn add<'a>(
        prefix: &str,
        message: &'a DescriptorProto,
        into: &mut BTreeMap<String, &'a DescriptorProto>,
    ) {
        let name = format!("{prefix}.{}", message.name());
        for nested in &message.nested_type {
            add(&name, nested, into);
        }
        into.insert(name, message);
    }
    let mut all = BTreeMap::new();
    for file in &set.file {
        for message in &file.message_type {
            add(&format!(".{}", file.package()), message, &mut all);
        }
    }
    all
}

/// Whether `name`, or any message it contains, has a `bytes` field.
fn carries_bytes(
    name: &str,
    all: &BTreeMap<String, &DescriptorProto>,
    seen: &mut BTreeSet<String>,
) -> bool {
    if !seen.insert(name.to_owned()) {
        return false;
    }
    let Some(message) = all.get(name) else {
        return false;
    };
    message.field.iter().any(|field| match field.r#type() {
        Type::Bytes => true,
        Type::Message => carries_bytes(field.type_name(), all, seen),
        _ => false,
    })
}

/// The streaming RPCs whose messages carry bytes (unary RPCs are not checked: the only ones
/// carrying `bytes` carry credentials), as `(service, method)`: the Control Plane's,
/// or with `peer_local` also those a Worker Host or Gateway serves itself.
fn byte_streams(peer_local: bool) -> BTreeSet<(String, String)> {
    let set = FileDescriptorSet::decode(supertag_protocol::FILE_DESCRIPTOR_SET)
        .expect("compiled descriptors");
    let all = messages(&set);
    let mut found = BTreeSet::new();
    for file in &set.file {
        for service in &file.service {
            for method in &service.method {
                let Some(roles) = access(service.name(), method.name()) else {
                    continue;
                };
                // Peer-local services run on a Worker Host or Gateway, never the Control Plane.
                if roles & PEER_LOCAL != 0 && !peer_local {
                    continue;
                }
                let streams = method.client_streaming() || method.server_streaming();
                let bytes = carries_bytes(method.input_type(), &all, &mut BTreeSet::new())
                    || carries_bytes(method.output_type(), &all, &mut BTreeSet::new());
                if streams && bytes {
                    found.insert((service.name().to_owned(), method.name().to_owned()));
                }
            }
        }
    }
    found
}

/// Services a Worker Host serves itself, to its harness, its sandbox provider, or peer hosts.
fn served_by_a_worker_host(service: &str) -> bool {
    service.starts_with("Harness")
        || matches!(
            service,
            "RemoteWorkspaceProvider" | "WorkerArtifactTransfers"
        )
}

#[test]
fn the_control_plane_and_gateways_stream_no_file_bytes() {
    let found = byte_streams(false);
    assert!(
        found.is_empty(),
        "the Control Plane must not relay files; these RPCs stream bytes: {found:?}"
    );
    // Every other byte stream is a Worker Host's own, never a Gateway's.
    let elsewhere: Vec<_> = byte_streams(true)
        .into_iter()
        .filter(|(service, _)| !served_by_a_worker_host(service))
        .collect();
    assert!(
        elsewhere.is_empty(),
        "only Worker Hosts serve file bytes; these RPCs stream bytes: {elsewhere:?}"
    );
}

/// The scan still finds byte streams where they belong: a Worker Host stages a Workspace bundle
/// into its own sandbox provider, peer to peer. So finding none on the Control Plane means no
/// relay is left, not that the scan stopped seeing any.
#[test]
fn the_scan_finds_byte_streams_that_stay_between_peers() {
    let peers = byte_streams(true);
    assert!(peers.contains(&("RemoteWorkspaceProvider".to_owned(), "Stage".to_owned())));
    assert!(
        !byte_streams(false)
            .iter()
            .any(|(service, _)| service == "RemoteWorkspaceProvider")
    );
}
