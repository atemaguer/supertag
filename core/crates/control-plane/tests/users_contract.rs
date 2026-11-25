//! Users and their invite keys, on SQLite and PostgreSQL. A User is a person: one invite key
//! enrolls all their client devices and the Worker Hosts that belong to them, and client Auth Keys
//! no longer exist.

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:admin";

fn digest(text: &str) -> Vec<u8> {
    Sha256::digest(text).to_vec()
}

fn invite(name: &str, display: &str, key: &str) -> InviteUserRequest {
    InviteUserRequest {
        operation_id: format!("invite-{key}"),
        name: name.into(),
        display_name: display.into(),
        key_digest: digest(key),
        ..Default::default()
    }
}

fn enroll(role: PrincipalRole, name: &str, credential: &str) -> EnrollRequest {
    EnrollRequest {
        role: role.into(),
        name: name.into(),
        operation_id: format!("enroll-{name}"),
        token_digest: digest(credential),
    }
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store.put_tag("release-bot", "Ship", vec![]).await.unwrap();

    // Only an operator invites, and a name follows the Tag ID rules.
    assert!(matches!(
        store
            .invite_user("user:mallory", &invite("alice", "Alice Ng", "k1"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    for bad in ["Alice", "-alice", "alice-", &"a".repeat(51)] {
        assert!(
            matches!(
                store.invite_user(OPERATOR, &invite(bad, "A", "kx")).await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{bad}"
        );
    }
    assert!(matches!(
        store.invite_user(OPERATOR, &invite("alice", "", "k1")).await,
        Err(StoreError::InvalidArgument(message)) if message.contains("display name")
    ));

    // The first invitation creates the User and a reusable key that names them.
    let first = store
        .invite_user(
            OPERATOR,
            &InviteUserRequest {
                allowed_tag_ids: vec!["release-bot".into()],
                role: "personal".into(),
                ..invite("alice", "  Alice   Ng ", "k1")
            },
        )
        .await
        .unwrap();
    let user = first.user.clone().unwrap();
    assert_eq!(user.name, "alice");
    assert_eq!(user.display_name, "Alice Ng");
    assert_eq!(user.role, "personal");
    assert_eq!(user.allowed_tag_ids, ["release-bot"]);
    let key = first.auth_key.clone().unwrap();
    assert_eq!(key.name, "alice-invite-1");
    assert_eq!(key.user, "alice");
    assert!(key.reusable);
    assert_eq!(key.role, PrincipalRole::Client as i32);
    assert_eq!(key.allowed_tag_ids, ["release-bot"]);
    // Seven days by default.
    assert_eq!(key.expires_at_ms - key.created_at_ms, 7 * 24 * 60 * 60_000);

    // A repeat of the same invitation returns the same User and key; other details conflict.
    let repeat = store
        .invite_user(
            OPERATOR,
            &InviteUserRequest {
                allowed_tag_ids: vec!["release-bot".into()],
                role: "personal".into(),
                ..invite("alice", "Alice Ng", "k1")
            },
        )
        .await
        .unwrap();
    assert_eq!(repeat, first);
    assert!(matches!(
        store
            .invite_user(OPERATOR, &invite("alice", "Alice Ng", "k1"))
            .await,
        Err(StoreError::Conflict(_))
    ));

    // Inviting an existing User again issues another key and keeps their details.
    let again = store
        .invite_user(OPERATOR, &invite("alice", "", "k2"))
        .await
        .unwrap();
    assert_eq!(again.user, first.user);
    assert_eq!(again.auth_key.unwrap().name, "alice-invite-2");
    assert!(matches!(
        store
            .invite_user(
                OPERATOR,
                &InviteUserRequest {
                    role: "admin".into(),
                    ..invite("alice", "", "k3")
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(message)) if message.contains("already exists")
    ));

    // Client Auth Keys are gone: people join with an invitation.
    assert!(matches!(
        store
            .create_auth_key(
                OPERATOR,
                &CreateAuthKeyRequest {
                    name: "laptops".into(),
                    role: PrincipalRole::Client.into(),
                    operation_id: "laptops".into(),
                    key_digest: digest("client key"),
                    all_tags: true,
                    ..Default::default()
                },
            )
            .await,
        Err(StoreError::InvalidArgument(message)) if message.contains("user invite")
    ));

    // One key enrolls two of Alice's devices and a Worker Host that belongs to her.
    let laptop = store
        .enroll(
            &digest("k1"),
            &enroll(PrincipalRole::Client, "alice-laptop", "laptop credential"),
        )
        .await
        .unwrap();
    assert_eq!(laptop.user, "alice");
    assert_eq!(laptop.principal, "client:alice-laptop");
    let desktop = store
        .enroll(
            &digest("k2"),
            &enroll(PrincipalRole::Client, "alice-desktop", "desktop credential"),
        )
        .await
        .unwrap();
    assert_eq!(desktop.user, "alice");
    let host = store
        .enroll(
            &digest("k1"),
            &enroll(PrincipalRole::Host, "alice-box", "host credential"),
        )
        .await
        .unwrap();
    assert_eq!(host.user, "alice");
    assert_eq!(host.principal, "host:alice-box");
    // A Gateway is never a person's.
    assert!(matches!(
        store
            .enroll(
                &digest("k1"),
                &enroll(
                    PrincipalRole::Gateway,
                    "alice-gateway",
                    "gateway credential"
                ),
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // A device's credential resolves to its own principal and names its User.
    let resolved = store
        .resolve_credential(&digest("desktop credential"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            resolved.role,
            resolved.name.as_str(),
            resolved.user.as_str()
        ),
        (PrincipalRole::Client as i32, "alice-desktop", "alice")
    );
    let resolved = store
        .resolve_credential(&digest("host credential"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.user, "alice");

    // Alice, from any device, reaches only the shared Tags her invitation lists.
    store.put_tag("private-bot", "Keep", vec![]).await.unwrap();
    let tags = store
        .list_tags("user:alice", &ListTagsRequest::default())
        .await
        .unwrap()
        .tags
        .into_iter()
        .map(|tag| tag.tag_id)
        .collect::<Vec<_>>();
    assert_eq!(tags, ["release-bot"]);

    // Reads.
    store
        .invite_user(OPERATOR, &invite("bob", "Bob", "k4"))
        .await
        .unwrap();
    assert_eq!(
        store
            .get_user(OPERATOR, &GetUserRequest { name: "bob".into() })
            .await
            .unwrap()
            .display_name,
        "Bob"
    );
    assert!(matches!(
        store
            .get_user(
                OPERATOR,
                &GetUserRequest {
                    name: "carol".into()
                }
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    let page = store
        .list_users(
            OPERATOR,
            &ListUsersRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.users.len(), 1);
    assert_eq!(page.users[0].name, "alice");
    assert_eq!(page.next_cursor, "alice");
    let rest = store
        .list_users(
            OPERATOR,
            &ListUsersRequest {
                cursor: page.next_cursor,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rest.users
            .iter()
            .map(|user| user.name.as_str())
            .collect::<Vec<_>>(),
        ["bob"]
    );
    assert!(rest.next_cursor.is_empty());
    store.close().await;
}

#[tokio::test]
async fn sqlite_users_contract() {
    exercise("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_users_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_users_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            tokio::task::spawn_local(async move { exercise(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
