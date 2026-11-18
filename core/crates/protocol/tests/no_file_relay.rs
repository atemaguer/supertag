//! The Control Plane relays no files (contributing/no-file-relay-plan.md): file bytes go from the
//! Worker Host that holds them to whoever reads them, through a Volume or a direct peer request,
//! never through the Control Plane or its API tier.
//!
//! This test finds every RPC the Control Plane serves (on its public listener, or internally to
//! its API tier) that streams messages carrying `bytes` fields, which is how a file crosses the
//! wire. Each one still in the protocol must be on [`REMAINING`], with the slice that removes it.
//! A new one fails the test, and so does a listed one that is gone, so each slice deletes its
//! entries as it deletes its handlers. When the plan is done, [`REMAINING`] is empty.
use std::collections::{BTreeMap, BTreeSet};

use prost::Message as _;
use prost_types::{DescriptorProto, FileDescriptorSet, field_descriptor_proto::Type};
use supertag_protocol::authorization::{PEER_LOCAL, access};

/// The byte-carrying RPCs the Control Plane still serves, and the no-file-relay slice that
/// removes each. Unary RPCs are not checked: the only ones carrying `bytes` carry credentials.
const REMAINING: &[(&str, &str, u8)] = &[
    // Slice 2: hosts fetch sources, continuations, and review patches from the git remote.
    ("Transfers", "DownloadReviewArtifact", 2),
    // Slice 6: the relay itself.
    ("HostRelay", "Deliver", 6),
];

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

/// The streaming RPCs whose messages carry bytes, as `(service, method)`: the Control Plane's,
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

#[test]
fn the_control_plane_streams_no_file_bytes_beyond_the_listed_relays() {
    let found = byte_streams(false);
    let listed: BTreeSet<(String, String)> = REMAINING
        .iter()
        .map(|(service, method, _)| ((*service).to_owned(), (*method).to_owned()))
        .collect();
    let new: Vec<_> = found.difference(&listed).collect();
    assert!(
        new.is_empty(),
        "the Control Plane must not relay files; these RPCs stream bytes: {new:?}"
    );
    let gone: Vec<_> = listed.difference(&found).collect();
    assert!(
        gone.is_empty(),
        "these relays are gone; delete them from REMAINING: {gone:?}"
    );
}

/// The scan still finds byte streams where they belong: a Worker Host stages a Workspace bundle
/// into its own sandbox provider, peer to peer. So an empty [`REMAINING`] means no relay is left,
/// not that the scan stopped seeing any.
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
