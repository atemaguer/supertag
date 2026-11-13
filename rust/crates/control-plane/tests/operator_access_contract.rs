//! Operator Tokens and the general audit log against SQLite and PostgreSQL.
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, Row};
use supertag_control_plane::{
    AuditRecord, OPERATOR_TOKEN_LIFETIME_MS, OperatorAuthentication, Store, StoreError,
};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_790_000_000_000;

fn secret(label: &str) -> (String, Vec<u8>) {
    let secret = format!(
        "stop_{:0>64}",
        label
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let digest = Sha256::digest(secret.as_bytes()).to_vec();
    (secret, digest)
}

fn create(name: &str, operation: &str, digest: &[u8]) -> CreateOperatorTokenRequest {
    CreateOperatorTokenRequest {
        name: name.into(),
        operation_id: operation.into(),
        secret_digest: digest.to_vec(),
    }
}

fn record(actor: &str, action: &str, target: &str, succeeded: bool) -> AuditRecord {
    AuditRecord {
        actor: actor.into(),
        action: action.into(),
        target: target.into(),
        succeeded,
        code: if succeeded { "OK" } else { "NOT_FOUND" }.into(),
        method: "/supertag.runtime.v2.Operator/PutTag".into(),
    }
}

async fn operator_access_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let time = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || time.load(Ordering::SeqCst));

    // Creation validates the name and the digest, and records a fixed lifetime.
    let (laptop, laptop_digest) = secret("laptop");
    for (name, digest) in [
        ("Laptop 2", laptop_digest.clone()),
        ("laptop-2", vec![1; 31]),
    ] {
        assert!(matches!(
            store
                .create_operator_token("local", &create(name, "bad", &digest))
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    let created = store
        .create_operator_token(
            "local",
            &create("laptop-2", "create-laptop", &laptop_digest),
        )
        .await
        .unwrap();
    assert_eq!(created.operator_id, "token:laptop-2");
    assert_eq!(created.phase(), OperatorTokenPhase::Active);
    assert_eq!(created.created_by, "local");
    assert_eq!(created.secret_revision, 1);
    assert_eq!(
        created.expires_at_ms - created.created_at_ms,
        OPERATOR_TOKEN_LIFETIME_MS
    );
    assert_eq!(created.last_used_at_ms, None);
    // A retry returns the same token; a new creation never reuses the name or the secret.
    assert_eq!(
        store
            .create_operator_token(
                "local",
                &create("laptop-2", "create-laptop", &laptop_digest)
            )
            .await
            .unwrap(),
        created
    );
    assert!(matches!(
        store
            .create_operator_token("local", &create("laptop-2", "again", &secret("other").1))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .create_operator_token("local", &create("ci", "reuse", &laptop_digest))
            .await,
        Err(StoreError::Conflict(_))
    ));
    let (ci, ci_digest) = secret("ci");
    store
        .create_operator_token("local", &create("ci", "create-ci", &ci_digest))
        .await
        .unwrap();
    let page = store
        .list_operator_tokens(&ListOperatorTokensRequest {
            limit: 1,
            cursor: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(
        (
            page.tokens.len(),
            page.tokens[0].name.as_str(),
            page.next_cursor.as_str()
        ),
        (1, "ci", "ci")
    );
    let rest = store
        .list_operator_tokens(&ListOperatorTokensRequest {
            limit: 1,
            cursor: page.next_cursor,
        })
        .await
        .unwrap();
    assert_eq!(rest.tokens[0].name, "laptop-2");
    assert!(rest.next_cursor.is_empty());
    assert!(matches!(
        store
            .list_operator_tokens(&ListOperatorTokensRequest {
                limit: 501,
                cursor: String::new(),
            })
            .await,
        Err(StoreError::InvalidArgument(_))
    ));

    // Authentication resolves a digest and refreshes last use at most once a minute.
    clock.store(NOW + 1_000, Ordering::SeqCst);
    assert_eq!(
        store
            .authenticate_operator_token(&laptop_digest)
            .await
            .unwrap(),
        OperatorAuthentication::Authenticated("token:laptop-2".into())
    );
    assert_eq!(
        store
            .get_operator_token("laptop-2")
            .await
            .unwrap()
            .last_used_at_ms,
        Some(NOW + 1_000)
    );
    clock.store(NOW + 30_000, Ordering::SeqCst);
    store
        .authenticate_operator_token(&laptop_digest)
        .await
        .unwrap();
    assert_eq!(
        store
            .get_operator_token("laptop-2")
            .await
            .unwrap()
            .last_used_at_ms,
        Some(NOW + 1_000)
    );
    clock.store(NOW + 120_000, Ordering::SeqCst);
    store
        .authenticate_operator_token(&laptop_digest)
        .await
        .unwrap();
    assert_eq!(
        store
            .get_operator_token("laptop-2")
            .await
            .unwrap()
            .last_used_at_ms,
        Some(NOW + 120_000)
    );
    for wrong in [secret("unknown").1, vec![0; 3]] {
        assert_eq!(
            store.authenticate_operator_token(&wrong).await.unwrap(),
            OperatorAuthentication::Invalid
        );
    }

    // Only digests are stored: no column holds the secret.
    let mut raw = String::new();
    for row in sqlx::query(
        "SELECT name, secret_digest, operation_id, created_by FROM supertag_v2_operator_tokens",
    )
    .fetch_all(&raw_pool(url).await)
    .await
    .unwrap()
    {
        for column in ["name", "secret_digest", "operation_id", "created_by"] {
            raw.push_str(&row.try_get::<String, _>(column).unwrap());
        }
    }
    assert!(!raw.contains(&laptop) && !raw.contains(&ci));
    assert!(raw.contains(&hex(&laptop_digest)));

    // Rotation replaces the secret, restarts the lifetime, and refuses the old secret.
    let (rotated_secret, rotated_digest) = secret("laptop-rotated");
    let rotate = RotateOperatorTokenRequest {
        name: "laptop-2".into(),
        operation_id: "rotate-laptop".into(),
        secret_digest: rotated_digest.clone(),
    };
    let rotated = store.rotate_operator_token(&rotate).await.unwrap();
    assert_eq!(
        (
            rotated.secret_revision,
            rotated.rotated_at_ms,
            rotated.expires_at_ms
        ),
        (
            2,
            Some(NOW + 120_000),
            NOW + 120_000 + OPERATOR_TOKEN_LIFETIME_MS
        )
    );
    assert_eq!(store.rotate_operator_token(&rotate).await.unwrap(), rotated);
    assert!(matches!(
        store
            .rotate_operator_token(&RotateOperatorTokenRequest {
                secret_digest: secret("different").1,
                ..rotate.clone()
            })
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .authenticate_operator_token(&laptop_digest)
            .await
            .unwrap(),
        OperatorAuthentication::Invalid
    );
    assert_eq!(
        store
            .authenticate_operator_token(&rotated_digest)
            .await
            .unwrap(),
        OperatorAuthentication::Authenticated("token:laptop-2".into())
    );
    assert!(!rotated_secret.is_empty());
    // A late retry of a superseded rotation never restores its secret.
    clock.store(NOW + 121_000, Ordering::SeqCst);
    let (_, later_digest) = secret("laptop-later");
    let later = store
        .rotate_operator_token(&RotateOperatorTokenRequest {
            name: "laptop-2".into(),
            operation_id: "rotate-laptop-later".into(),
            secret_digest: later_digest.clone(),
        })
        .await
        .unwrap();
    assert_eq!(later.secret_revision, 3);
    assert!(matches!(
        store.rotate_operator_token(&rotate).await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(store.get_operator_token("laptop-2").await.unwrap(), later);
    assert_eq!(
        store
            .authenticate_operator_token(&rotated_digest)
            .await
            .unwrap(),
        OperatorAuthentication::Invalid
    );
    // A secret a token held before is never accepted again, by any rotation or creation.
    for reused in [&laptop_digest, &rotated_digest] {
        assert!(matches!(
            store
                .rotate_operator_token(&RotateOperatorTokenRequest {
                    name: "laptop-2".into(),
                    operation_id: format!("reuse-{}", hex(reused)),
                    secret_digest: reused.clone(),
                })
                .await,
            Err(StoreError::Conflict(_))
        ));
        assert!(matches!(
            store
                .create_operator_token("local", &create("fresh", "fresh", reused))
                .await,
            Err(StoreError::Conflict(_))
        ));
    }
    assert_eq!(
        store
            .authenticate_operator_token(&later_digest)
            .await
            .unwrap(),
        OperatorAuthentication::Authenticated("token:laptop-2".into())
    );

    // Expiry: the token is refused at its expiry time, and rotation renews it.
    clock.store(NOW + OPERATOR_TOKEN_LIFETIME_MS, Ordering::SeqCst);
    assert_eq!(
        store.authenticate_operator_token(&ci_digest).await.unwrap(),
        OperatorAuthentication::Expired
    );
    assert_eq!(
        store.get_operator_token("ci").await.unwrap().phase(),
        OperatorTokenPhase::Expired
    );

    // Revocation is immediate and idempotent, wins over expiry, and blocks rotation.
    let revoked = store.revoke_operator_token("ci").await.unwrap();
    assert_eq!(revoked.phase(), OperatorTokenPhase::Revoked);
    clock.store(NOW + OPERATOR_TOKEN_LIFETIME_MS + 5, Ordering::SeqCst);
    assert_eq!(
        store
            .revoke_operator_token("ci")
            .await
            .unwrap()
            .revoked_at_ms,
        revoked.revoked_at_ms
    );
    assert_eq!(
        store.authenticate_operator_token(&ci_digest).await.unwrap(),
        OperatorAuthentication::Revoked
    );
    assert!(matches!(
        store
            .rotate_operator_token(&RotateOperatorTokenRequest {
                name: "ci".into(),
                operation_id: "rotate-ci".into(),
                secret_digest: secret("ci-new").1,
            })
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store.revoke_operator_token("missing").await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .create_operator_token("local", &create("ci", "recreate", &secret("ci-2").1))
            .await,
        Err(StoreError::Conflict(_))
    ));

    // The audit log lists newest first, filters by actor and time, and pages without gaps.
    clock.store(NOW, Ordering::SeqCst);
    let first = store
        .record_audit_entry(&record(
            "local",
            "operator-token.create",
            "OperatorToken/laptop-2",
            true,
        ))
        .await
        .unwrap();
    clock.store(NOW + 10, Ordering::SeqCst);
    store
        .record_audit_entry(&record("token:laptop-2", "tag.put", "Tag/reviewer", true))
        .await
        .unwrap();
    clock.store(NOW + 20, Ordering::SeqCst);
    store
        .record_audit_entry(&record("token:laptop-2", "tag.retire", "Tag", false))
        .await
        .unwrap();
    // A target names a kind and up to two 256-byte IDs, so it may exceed one ID's limit.
    let long = format!("MailboxGrant/{}->{}", "s".repeat(256), "r".repeat(256));
    let stored = store
        .record_audit_entry(&record("local", "mailbox-grant.change", &long, true))
        .await
        .unwrap();
    assert_eq!(stored.target, long);
    assert!(matches!(
        store
            .record_audit_entry(&record("local", "tag.put", &"t".repeat(1025), true))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    sqlx::query("DELETE FROM supertag_v2_audit_entries WHERE entry_id=$1")
        .bind(&stored.id)
        .execute(&raw_pool(url).await)
        .await
        .unwrap();
    let all = store
        .list_audit_entries(&ListAuditEntriesRequest::default())
        .await
        .unwrap();
    assert_eq!(
        all.entries
            .iter()
            .map(|entry| (
                entry.actor.as_str(),
                entry.action.as_str(),
                entry.target.as_str(),
                entry.outcome(),
                entry.code.as_str()
            ))
            .collect::<Vec<_>>(),
        [
            (
                "token:laptop-2",
                "tag.retire",
                "Tag",
                AuditOutcome::Failed,
                "NOT_FOUND"
            ),
            (
                "token:laptop-2",
                "tag.put",
                "Tag/reviewer",
                AuditOutcome::Succeeded,
                "OK"
            ),
            (
                "local",
                "operator-token.create",
                "OperatorToken/laptop-2",
                AuditOutcome::Succeeded,
                "OK"
            ),
        ]
    );
    assert_eq!(all.entries[2], first);
    let by_actor = store
        .list_audit_entries(&ListAuditEntriesRequest {
            actor: "local".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(by_actor.entries, std::slice::from_ref(&first));
    let since = store
        .list_audit_entries(&ListAuditEntriesRequest {
            since_ms: NOW + 10,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(since.entries.len(), 2);
    let page = store
        .list_audit_entries(&ListAuditEntriesRequest {
            limit: 2,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 2);
    // An entry recorded between pages appears on neither continuation page nor repeats.
    store
        .record_audit_entry(&record("local", "team.create", "Team/core", true))
        .await
        .unwrap();
    let next = store
        .list_audit_entries(&ListAuditEntriesRequest {
            limit: 2,
            cursor: page.next_cursor.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(next.entries, [first]);
    assert!(next.next_cursor.is_empty());
    for invalid in [
        ListAuditEntriesRequest {
            limit: 501,
            ..Default::default()
        },
        ListAuditEntriesRequest {
            since_ms: -1,
            ..Default::default()
        },
        ListAuditEntriesRequest {
            cursor: "nope".into(),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            store.list_audit_entries(&invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    store.close().await;
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A separate pool for raw inspection of the stored rows.
async fn raw_pool(url: &str) -> sqlx::AnyPool {
    sqlx::any::install_default_drivers();
    sqlx::AnyPool::connect(url).await.unwrap()
}

#[tokio::test]
async fn sqlite_operator_access_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("access.db").display()
    );
    operator_access_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_operator_access_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_access_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { operator_access_contract(url.as_str()).await })
                .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL operator access contract failed");
}
