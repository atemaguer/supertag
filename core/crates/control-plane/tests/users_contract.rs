//! Users and their invite keys, on SQLite and PostgreSQL. A User is a person: one invite key
//! enrolls all their client devices and the Worker Hosts that belong to them, and client Auth Keys
//! no longer exist.

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
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

/// A Worker Host the Control Plane's configuration seeds for every Tag.
async fn support_host(store: &Store, id: &str) -> HostAuthority {
    store
        .seed_host(id, &digest(&format!("seeded {id}")))
        .await
        .unwrap();
    let record = store.register_host(id, "incarnation").await.unwrap();
    HostAuthority::new(format!("host:{id}"), record.generation).unwrap()
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store.put_tag("release-bot", "Ship", vec![]).await.unwrap();
    // What every personal Tag may do is the operator's `personal` Role.
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "personal-role".into(),
                role: Some(Role {
                    role_id: "personal".into(),
                    name: "Personal".into(),
                    purpose: "Work for one person".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();

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

    // Alice, from any device, reaches her own Tag and the shared Tags her invitation lists.
    store.put_tag("private-bot", "Keep", vec![]).await.unwrap();
    let tags = store
        .list_tags("user:alice", &ListTagsRequest::default())
        .await
        .unwrap()
        .tags
        .into_iter()
        .map(|tag| tag.tag_id)
        .collect::<Vec<_>>();
    assert_eq!(tags, ["alice", "release-bot"]);

    // Alice's personal Tag: named after her, owned by her, with the `personal` Role.
    let personal = store.get_tag("alice").await.unwrap();
    assert_eq!(personal.owner, "alice");
    let roles = store
        .list_role_assignments(
            OPERATOR,
            &ListRoleAssignmentsRequest {
                tag_id: "alice".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        roles
            .assignments
            .iter()
            .map(|assignment| assignment.role_id.as_str())
            .collect::<Vec<_>>(),
        ["personal"]
    );
    // A personal Tag takes its User's name, so a taken Tag ID refuses the User, and an
    // invitation names a Role that exists and only shared Tags.
    assert!(matches!(
        store
            .invite_user(OPERATOR, &invite("release-bot", "Bot", "k5"))
            .await,
        Err(StoreError::FailedPrecondition(message)) if message.contains("already exists")
    ));
    assert!(matches!(
        store
            .invite_user(
                OPERATOR,
                &InviteUserRequest {
                    role: "missing".into(),
                    ..invite("carol", "Carol", "k6")
                }
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .invite_user(
                OPERATOR,
                &InviteUserRequest {
                    allowed_tag_ids: vec!["alice".into()],
                    ..invite("carol", "Carol", "k7")
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(message)) if message.contains("personal Tag")
    ));
    assert!(
        store.get_tag("carol").await.is_err(),
        "a refused invitation left a Tag"
    );

    // The owner configures how her Tag works; the operator grants what it may do.
    let configured = store
        .put_tag_as(
            "user:alice",
            PutTagRequest {
                tag_id: "alice".into(),
                instructions: "Keep my notes short".into(),
                harness_kind: HarnessKind::Codex.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(configured.instructions, "Keep my notes short");
    assert_eq!(configured.owner, "alice");
    assert!(matches!(
        store
            .put_tag_as(
                "user:alice",
                PutTagRequest {
                    tag_id: "alice".into(),
                    allowed_actions: vec!["commands:execute".into()],
                    ..Default::default()
                },
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    for (who, tag) in [("user:alice", "release-bot"), ("user:bob", "alice")] {
        assert!(
            matches!(
                store
                    .put_tag_as(
                        who,
                        PutTagRequest {
                            tag_id: tag.into(),
                            instructions: "Mine now".into(),
                            ..Default::default()
                        },
                    )
                    .await,
                Err(StoreError::NotFound(_))
            ),
            "{who} wrote {tag}"
        );
    }

    // Alice's Worker Host runs only her Tags; a host for every Tag runs shared Tags only; a
    // shared host an operator binds to alice by name runs hers.
    let submit = |tag: &'static str, session: &'static str| {
        let store = store.clone();
        async move {
            store
                .submit_task(
                    OPERATOR,
                    &SubmitTaskRequest {
                        tag_id: tag.into(),
                        session_id: session.into(),
                        operation_id: format!("{tag}-{session}"),
                        prompt: "Work".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
                .task_id
        }
    };
    let host_authority = |id: &'static str| {
        let store = store.clone();
        async move {
            let record = store.register_host(id, "incarnation").await.unwrap();
            HostAuthority::new(format!("host:{id}"), record.generation).unwrap()
        }
    };
    let claimed = |host: HostAuthority| {
        let store = store.clone();
        async move {
            // Alice chose Codex for her Tag; the shared Tag names no harness.
            store
                .claim_task_for_host(&host, &Uuid::new_v4().to_string(), &[], HarnessKind::Codex)
                .await
                .unwrap()
                .map(|assignment| assignment.task.unwrap().tag_id)
        }
    };
    let alices = submit("alice", "first").await;
    let shared = submit("release-bot", "first").await;
    let _ = (&alices, &shared);
    let shared_host = support_host(&store, "shared-box").await;
    assert_eq!(
        claimed(shared_host.clone()).await.as_deref(),
        Some("release-bot")
    );
    assert_eq!(
        claimed(shared_host).await,
        None,
        "a host for every Tag ran alice's Tag"
    );
    let alice_box = host_authority("alice-box").await;
    assert_eq!(claimed(alice_box.clone()).await.as_deref(), Some("alice"));
    submit("release-bot", "second").await;
    assert_eq!(
        claimed(alice_box).await,
        None,
        "alice's host ran a shared Tag"
    );
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: "bound".into(),
                role: PrincipalRole::Host.into(),
                operation_id: "bound".into(),
                key_digest: digest("bound key"),
                allowed_tag_ids: vec!["alice".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .enroll(
            &digest("bound key"),
            &enroll(PrincipalRole::Host, "bound-box", "bound credential"),
        )
        .await
        .unwrap();
    submit("alice", "second").await;
    assert_eq!(
        claimed(host_authority("bound-box").await).await.as_deref(),
        Some("alice")
    );

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
