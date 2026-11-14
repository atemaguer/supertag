use sha2::{Digest, Sha256};
use supertag_control_plane::{HostAuthority, Store};

/// The artifact storage a test Worker Host registers. The Control Plane stores no artifact bytes:
/// every capture names the producing host's registered storage, which holds them.
pub const ARTIFACT_STORAGE: &str = "6f1c6d2e-6c1a-4b7e-9f5d-3c2b1a0f9e8d";

/// Registers [`ARTIFACT_STORAGE`] for `host`'s current generation.
#[allow(dead_code)]
pub async fn hold_artifacts(store: &Store, host: &HostAuthority) {
    store
        .register_artifact_source(
            host,
            &supertag_protocol::v2::RegisterArtifactSourceRequest {
                storage_id: ARTIFACT_STORAGE.into(),
            },
        )
        .await
        .unwrap();
}

pub async fn register_host(store: &Store, id: &str) -> HostAuthority {
    let credential = Sha256::digest(format!("store contract test: {id}"));
    store.seed_host(id, &credential).await.unwrap();
    let record = store.register_host(id, "test-incarnation").await.unwrap();
    HostAuthority::new(format!("host:{id}"), record.generation).unwrap()
}
