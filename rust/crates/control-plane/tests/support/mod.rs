use sha2::{Digest, Sha256};
use supertag_control_plane::{HostAuthority, Store};

pub async fn register_host(store: &Store, id: &str) -> HostAuthority {
    let credential = Sha256::digest(format!("store contract test: {id}"));
    store.seed_host(id, &credential).await.unwrap();
    let record = store.register_host(id, "test-incarnation").await.unwrap();
    HostAuthority::new(format!("host:{id}"), record.generation).unwrap()
}
