//! Fenced connector ownership: one Gateway delivers an account's replies at a time,
//! a released or expired owner hands over at once, and only the owner claims replies.
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::{
    ClaimConnectorRequest, ClaimReplyRequest, ReleaseConnectorRequest, RenewConnectorRequest,
};
use uuid::Uuid;

const ACME: &str = "connector:acme";

fn claim(owner: &str) -> ClaimConnectorRequest {
    ClaimConnectorRequest {
        owner_id: owner.into(),
    }
}

fn reply(operation: &str, lease: &str) -> ClaimReplyRequest {
    ClaimReplyRequest {
        operation_id: operation.into(),
        connector_lease_token: lease.into(),
    }
}

async fn contract(url: String) {
    let now = Arc::new(AtomicI64::new(1_800_000_000_000));
    let clock = now.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst));

    let first = store
        .claim_connector(ACME, &claim("gateway-a"))
        .await
        .unwrap();
    assert!(first.granted);
    assert_eq!(first.fence, 1);
    assert!(first.valid_for_ms >= 10_000);

    // Another Gateway waits; a different account is independent.
    let busy = store
        .claim_connector(ACME, &claim("gateway-b"))
        .await
        .unwrap();
    assert!(!busy.granted && busy.lease_token.is_empty());
    assert!(busy.retry_after_ms > 0 && busy.retry_after_ms <= first.valid_for_ms);
    assert!(
        store
            .claim_connector("connector:other", &claim("gateway-b"))
            .await
            .unwrap()
            .granted
    );

    // Only the current owner claims replies; a missing or foreign token is refused.
    assert!(
        store
            .claim_owned_reply(ACME, &reply("owned", &first.lease_token))
            .await
            .unwrap()
            .reply
            .is_none()
    );
    for token in ["", "forged"] {
        assert!(
            store
                .claim_owned_reply(ACME, &reply("forged", token))
                .await
                .is_err(),
            "token {token:?} claimed a reply"
        );
    }
    assert!(matches!(
        store
            .claim_owned_reply("connector:other", &reply("cross", &first.lease_token))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .claim_connector("operator:alice", &claim("gateway-a"))
            .await,
        Err(StoreError::PermissionDenied)
    ));

    // The same stable owner (a restart with the same private state) reclaims at
    // once with a new fence; the previous process's token stops working.
    let restarted = store
        .claim_connector(ACME, &claim("gateway-a"))
        .await
        .unwrap();
    assert!(restarted.granted);
    assert_eq!(restarted.fence, 2);
    assert_ne!(restarted.lease_token, first.lease_token);
    assert!(matches!(
        store
            .renew_connector(
                ACME,
                &RenewConnectorRequest {
                    lease_token: first.lease_token.clone()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // Renewal extends ownership past the original expiry.
    now.fetch_add(10_000, Ordering::SeqCst);
    store
        .renew_connector(
            ACME,
            &RenewConnectorRequest {
                lease_token: restarted.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    now.fetch_add(10_000, Ordering::SeqCst);
    assert!(
        !store
            .claim_connector(ACME, &claim("gateway-b"))
            .await
            .unwrap()
            .granted
    );

    // Drain: release hands over immediately, across Store instances (restart).
    store
        .release_connector(
            ACME,
            &ReleaseConnectorRequest {
                lease_token: restarted.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    // Releasing a lease that is no longer current is harmless.
    store
        .release_connector(
            ACME,
            &ReleaseConnectorRequest {
                lease_token: restarted.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store.close().await;
    let clock = now.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst));
    let second = store
        .claim_connector(ACME, &claim("gateway-b"))
        .await
        .unwrap();
    assert!(second.granted);
    assert_eq!(second.fence, 3);
    assert!(
        store
            .claim_owned_reply(ACME, &reply("released", &restarted.lease_token))
            .await
            .is_err()
    );
    assert!(
        store
            .claim_owned_reply(ACME, &reply("taken-over", &second.lease_token))
            .await
            .is_ok()
    );

    // A crashed owner that never releases is replaced after expiry, not before.
    now.fetch_add(second.valid_for_ms as i64 - 1, Ordering::SeqCst);
    assert!(
        !store
            .claim_connector(ACME, &claim("gateway-c"))
            .await
            .unwrap()
            .granted
    );
    now.fetch_add(1, Ordering::SeqCst);
    let third = store
        .claim_connector(ACME, &claim("gateway-c"))
        .await
        .unwrap();
    assert!(third.granted);
    assert_eq!(third.fence, 4);
    assert!(
        store
            .claim_owned_reply(ACME, &reply("expired", &second.lease_token))
            .await
            .is_err()
    );

    // Concurrent claims from two Gateways grant exactly one owner.
    now.fetch_add(third.valid_for_ms as i64, Ordering::SeqCst);
    let other = Store::open(&url).await.unwrap().with_execution_clock({
        let clock = now.clone();
        move || clock.load(Ordering::SeqCst)
    });
    let (d, e) = (claim("gateway-d"), claim("gateway-e"));
    let (left, right) = tokio::join!(
        store.claim_connector(ACME, &d),
        other.claim_connector(ACME, &e)
    );
    assert_eq!(
        [left.unwrap().granted, right.unwrap().granted]
            .iter()
            .filter(|granted| **granted)
            .count(),
        1
    );
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_connector_ownership_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_connector_ownership_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_ownership_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL connector ownership contract failed");
}
