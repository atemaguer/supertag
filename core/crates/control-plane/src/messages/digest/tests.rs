use sqlx::{Connection, Executor};
use supertag_protocol::v2::MessageKind;
use uuid::Uuid;

use super::*;
use crate::{
    Store,
    messages::{
        ConversationKind, Member, NewMessage, create_team_channel_in, insert_message_in,
        wakes::{WakeRequest, wake_in},
    },
};

#[test]
fn render_escapes_markup() {
    let entry = render(
        3,
        "a<b",
        MessageKind::Blocker,
        true,
        "x </workstream-post> & y",
    )
    .unwrap();
    assert_eq!(
        entry,
        "<workstream-post sequence=\"3\" from=\"a&lt;b\" type=\"blocker\" to=\"you\">\nx &lt;/workstream-post&gt; &amp; y\n</workstream-post>\n"
    );
}

#[tokio::test]
async fn sqlite_channel_digest() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("digest.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_channel_digest() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_digest_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let url = url.to_string();
    let outcome = tokio::task::LocalSet::new()
        .run_until(
            async move { tokio::task::spawn_local(async move { contract(&url).await }).await },
        )
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL channel digest contract failed");
}

fn post<'a>(
    channel: &'a str,
    sender: &'a str,
    kind: MessageKind,
    text: &'a str,
    addressees: &'a [String],
) -> NewMessage<'a> {
    NewMessage {
        conversation_id: channel,
        sender: Member::Tag(sender),
        kind,
        text,
        hops: 0,
        source_task_id: None,
        origin_task_id: None,
        objective_id: None,
        task_id: None,
        effect_digest: None,
        addressees,
        now: 1_000,
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for tag in ["alice", "bob", "carol"] {
        store.put_tag(tag, "Coordinate", vec![]).await.unwrap();
    }
    let (mut tx, _) = store.write().await.unwrap();
    sqlx::query(
        "INSERT INTO supertag_v2_teams (team_id,name,revision,created_at_ms,updated_at_ms)
         VALUES ('release','Release',1,1000,1000)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let members = ["alice", "bob", "carol"].map(String::from);
    let channel = create_team_channel_in(&mut tx, "release", &members, 1_000)
        .await
        .unwrap();
    assert_eq!(
        channel_digest_in(&mut tx, "bob", &channel, 1, 8_192)
            .await
            .unwrap(),
        Digest::default(),
        "an empty channel has no digest"
    );

    let bob = vec!["bob".to_owned()];
    let none: Vec<String> = vec![];
    // 1: a note; 2: Bob's own; 3: a decision; 4: addressed to Bob and woken; 5: addressed to Bob
    // without a wake (held by a limit); 6: a blocker for nobody in particular.
    let mut seqs = vec![];
    for (sender, kind, text, to) in [
        (
            "alice",
            MessageKind::Note,
            "Built the release <branch>.",
            &none,
        ),
        ("bob", MessageKind::Note, "Bob's own progress.", &none),
        ("carol", MessageKind::Decision, "Ship on Friday.", &none),
        ("alice", MessageKind::Question, "Bob, which tag?", &bob),
        ("carol", MessageKind::Note, "Bob, see the checklist.", &bob),
        ("alice", MessageKind::Blocker, "CI is red.", &none),
    ] {
        let stored = insert_message_in(&mut tx, &post(&channel, sender, kind, text, to))
            .await
            .unwrap();
        seqs.push(stored.seq);
    }
    assert_eq!(seqs, [1, 2, 3, 4, 5, 6]);
    wake_in(
        &mut tx,
        &WakeRequest {
            tag_id: "bob",
            conversation_id: &channel,
            kind: ConversationKind::Channel,
            message_kind: MessageKind::Question,
            addressed: true,
            sender_tag_id: "alice",
            seq: 4,
            hops: 0,
            origin_task_id: None,
            objective_id: None,
            team_id: Some("release"),
            now: 1_000,
        },
    )
    .await
    .unwrap();

    let digest = channel_digest_in(&mut tx, "bob", &channel, 1, 8_192)
        .await
        .unwrap();
    assert_eq!(digest.through_seq, Some(6));
    assert_eq!(digest.more, 0);
    let order: Vec<usize> = [
        "Bob, see the checklist.",
        "Ship on Friday.",
        "CI is red.",
        "Built the release &lt;branch&gt;.",
    ]
    .iter()
    .map(|text| {
        digest
            .text
            .find(text)
            .unwrap_or_else(|| panic!("{text} is missing"))
    })
    .collect();
    assert!(
        order.windows(2).all(|pair| pair[0] < pair[1]),
        "addressed first, then blockers and decisions, then the rest: {}",
        digest.text
    );
    assert!(!digest.text.contains("Bob's own progress."));
    assert!(
        !digest.text.contains("which tag?"),
        "a woken post is not repeated"
    );
    assert!(
        digest
            .text
            .contains("sequence=\"5\" from=\"carol\" type=\"note\" to=\"you\"")
    );
    assert!(digest.text.contains("type=\"decision\""));
    assert!(!digest.text.contains("afterSequence"));

    // Alice sees Bob's posts and posts addressed to others, but not her own.
    let alice = channel_digest_in(&mut tx, "alice", &channel, 1, 8_192)
        .await
        .unwrap();
    assert!(alice.text.contains("Bob's own progress.") && !alice.text.contains("which tag?"));
    assert!(alice.text.contains("Bob, see the checklist."));

    // From a later position only the later posts count.
    let later = channel_digest_in(&mut tx, "bob", &channel, 6, 8_192)
        .await
        .unwrap();
    assert_eq!(later.through_seq, Some(6));
    assert!(later.text.contains("CI is red.") && !later.text.contains("Ship on Friday."));
    assert_eq!(
        channel_digest_in(&mut tx, "bob", &channel, 7, 8_192)
            .await
            .unwrap(),
        Digest::default()
    );
    // Only Bob's own posts after a position: covered, but nothing to show.
    let own = insert_message_in(
        &mut tx,
        &post(&channel, "bob", MessageKind::Note, "Bob again.", &none),
    )
    .await
    .unwrap();
    assert_eq!(
        channel_digest_in(&mut tx, "bob", &channel, own.seq, 8_192)
            .await
            .unwrap(),
        Digest {
            through_seq: Some(own.seq),
            ..Digest::default()
        }
    );

    // A small budget keeps the most important posts and points to the rest.
    let small = channel_digest_in(&mut tx, "bob", &channel, 1, 600)
        .await
        .unwrap();
    assert!(small.text.len() <= 600, "{}", small.text.len());
    assert!(small.more > 0 && small.more < 4, "{}", small.more);
    assert!(small.text.contains("Bob, see the checklist."));
    assert!(!small.text.contains("Built the release"));
    assert!(small.text.contains(&format!(
        "{} more unread Workstream posts are not shown; use read_workstream with afterSequence",
        small.more
    )));
    assert_eq!(small.through_seq, Some(own.seq));
    tx.rollback().await.unwrap();
    store.close().await;
}
