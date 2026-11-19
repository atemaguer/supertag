//! Guards against changing the wire protocol without deciding whether peers from the last
//! release can still speak it. `proto/protocol.lock` pairs the current protocol version with a
//! digest of every file under `proto/`, comments and layout aside. See "Changing proto/" in
//! AGENTS.md.
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::PROTOCOL_VERSIONS;

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn proto_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("read proto/") {
        let path = entry.expect("read proto/ entry").path();
        if path.is_dir() {
            proto_files(&path, files);
        } else if path
            .extension()
            .is_some_and(|extension| extension == "proto")
        {
            files.push(path);
        }
    }
}

/// A digest of the schema under `proto/` that comment and whitespace edits leave unchanged.
fn proto_digest() -> String {
    let root = repository().join("proto");
    let mut files = Vec::new();
    proto_files(&root, &mut files);
    files.sort();
    let mut digest = Sha256::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap().to_string_lossy();
        let text = std::fs::read_to_string(&file).expect("read a proto file");
        let schema = text
            .lines()
            .map(|line| {
                let code = line.split_once("//").map_or(line, |(code, _)| code);
                code.split_whitespace().collect::<Vec<_>>().join(" ")
            })
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        digest.update(relative.replace('\\', "/").as_bytes());
        digest.update([0]);
        digest.update(schema.as_bytes());
        digest.update([0]);
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn lock_entry<'a>(lock: &'a str, key: &str) -> &'a str {
    lock.lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix(' '))
        .unwrap_or_else(|| panic!("proto/protocol.lock has no `{key}` line"))
        .trim()
}

#[test]
fn proto_changes_are_paired_with_a_protocol_version_decision() {
    let lock = std::fs::read_to_string(repository().join("proto/protocol.lock"))
        .expect("read proto/protocol.lock");
    let current = *PROTOCOL_VERSIONS.last().expect("a protocol version");
    let locked: u32 = lock_entry(&lock, "protocol")
        .parse()
        .expect("a protocol version in proto/protocol.lock");
    assert_eq!(
        locked, current,
        "PROTOCOL_VERSIONS speaks protocol {current} but proto/protocol.lock names {locked}: \
         write `protocol {current}` and the current `sha256` to proto/protocol.lock"
    );
    let digest = proto_digest();
    assert_eq!(
        lock_entry(&lock, "sha256"),
        digest,
        "\n\nproto/ changed since proto/protocol.lock was written.\n\
         Would a peer from the last release misread or refuse this change (a removed, renamed \
         or renumbered field, method or message; a changed type; a new meaning for an old \
         value)? Then bump PROTOCOL_VERSIONS in core/crates/protocol/src/negotiation.rs to \
         [{next}] and in each client copy (see AGENTS.md, \"Changing proto/\"), and write \
         `protocol {next}`.\n\
         Either way, write this digest to proto/protocol.lock:\n\nsha256 {digest}\n",
        next = current + 1,
    );
}

/// Clients outside the Rust workspace keep their own copy of the version they speak.
#[test]
fn every_client_speaks_the_current_protocol_version() {
    let current = *PROTOCOL_VERSIONS.last().expect("a protocol version");
    for (file, declaration) in [
        (
            "sdks/typescript/src/gateway-client.ts",
            format!("const PROTOCOL_VERSIONS = [{current}];"),
        ),
        (
            "sdks/python/src/supertag/gateway_client.py",
            format!("_PROTOCOL_VERSIONS = ({current},)"),
        ),
    ] {
        let text = std::fs::read_to_string(repository().join(file)).expect("read a client");
        assert!(
            text.contains(&declaration),
            "{file} must declare `{declaration}` to speak the protocol this release speaks"
        );
    }
}
