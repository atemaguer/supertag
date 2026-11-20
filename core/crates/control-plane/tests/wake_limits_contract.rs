//! Typed direct messages, debounced wakes, and the wake limits that keep Tags from waking each
//! other in loops. Over a limit nothing is dropped: notes wait for the Tag's next turn, questions
//! and blockers are delivered late, the sender is told why, and the operator gets one Inbox item.
mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const HOUR_MS: i64 = 3_600_000;
/// The start of an hour window, so a test step never crosses one by accident.
const NOW: i64 = 527_778 * HOUR_MS;
const DEBOUNCE_MS: i64 = 3_000;

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
}

impl Fixture {
    async fn ordinary(&self, tag: &str) -> InspectAttemptRequest {
        self.store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: tag.into(),
                    session_id: "ordinary".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    prompt: "Coordinate".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        self.claim(tag).await
    }

    async fn try_claim(&self) -> Option<Assignment> {
        self.store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
    }

    /// Claims and starts the next Task, which must be the Tag's.
    async fn claim(&self, tag: &str) -> InspectAttemptRequest {
        let assignment = self.try_claim().await.expect("queued Task");
        let task = assignment.task.unwrap();
        assert_eq!(task.tag_id, tag);
        let attempt = InspectAttemptRequest {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        self.store
            .start_task(
                &self.host,
                &StartTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                },
            )
            .await
            .unwrap();
        attempt
    }

    async fn prompt(&self, attempt: &InspectAttemptRequest) -> String {
        self.store.get_task(&attempt.task_id).await.unwrap().prompt
    }

    async fn finish(&self, attempt: &InspectAttemptRequest) {
        self.store
            .finish_task(
                &self.host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    succeeded: true,
                    result: "Done".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    async fn send(
        &self,
        attempt: &InspectAttemptRequest,
        to: &str,
        text: &str,
        kind: MessageKind,
    ) -> Result<SendTagMessageResponse, StoreError> {
        self.store
            .send_attempt_tag_message(
                &AttemptAccess::new(&self.host, attempt),
                &SendAttemptTagMessageRequest {
                    kind: kind as i32,
                    operation_id: Uuid::new_v4().to_string(),
                    recipient_tag_id: to.into(),
                    text: text.into(),
                    review: None,
                },
            )
            .await
    }

    /// Lets the debounce pass and turns due wakes into inbox Tasks.
    async fn settle(&self, by: i64) {
        self.clock.fetch_add(by, Ordering::SeqCst);
        self.store.sweep_mailbox().await.unwrap();
    }

    async fn wake_limit_items(&self) -> Vec<InboxItem> {
        self.store
            .list_inbox_items(
                OPERATOR,
                &ListInboxItemsRequest {
                    kind: InboxItemKind::WakeLimit as i32,
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .items
    }

    async fn set_limits(&self, operation: &str, limits: TeamWakeLimits) -> Team {
        let team = self.store.get_team(OPERATOR, "crew").await.unwrap();
        self.store
            .update_team(
                OPERATOR,
                &UpdateTeamRequest {
                    operation_id: operation.into(),
                    team: "crew".into(),
                    expected_revision: team.revision,
                    wake_limits: Some(limits),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
    }
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for tag in ["a", "b", "c", "d"] {
        store
            .put_tag(tag, &format!("Identity {tag}"), vec![])
            .await
            .unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "crew".into(),
                team_id: "crew".into(),
                name: "Crew".into(),
                member_tag_ids: vec!["a".into(), "b".into(), "c".into(), "d".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "host").await;
    let fixture = Fixture { store, host, clock };
    typed_and_debounced(&fixture).await;
    mutual_limit(&fixture).await;
    hourly_limit_and_held_notes(&fixture).await;
    every_type_wakes(&fixture).await;
    team_overrides(&fixture).await;
    objective_limit(&fixture).await;
    fixture.store.close().await;
}

/// Notes and questions wait out the debounce so a burst lands in one turn; a blocker wakes now.
/// A Tag cannot choose the review type.
async fn typed_and_debounced(f: &Fixture) {
    let a0 = f.ordinary("a").await;
    for kind in [MessageKind::Review as i32, 99] {
        let refused = f
            .store
            .send_attempt_tag_message(
                &AttemptAccess::new(&f.host, &a0),
                &SendAttemptTagMessageRequest {
                    kind,
                    operation_id: format!("refused-{kind}"),
                    recipient_tag_id: "b".into(),
                    text: "Refused".into(),
                    review: None,
                },
            )
            .await;
        assert!(matches!(refused, Err(StoreError::InvalidArgument(_))));
    }
    let note = f
        .send(&a0, "b", "Note one", MessageKind::Note)
        .await
        .unwrap();
    assert_eq!(note.wake_deferred, "");
    assert_eq!(note.message.unwrap().kind(), MessageKind::Note);
    f.store.sweep_mailbox().await.unwrap();
    assert!(
        f.try_claim().await.is_none(),
        "a note waits out the debounce"
    );
    let question = f
        .send(&a0, "b", "Question one", MessageKind::Question)
        .await
        .unwrap();
    assert_eq!(question.message.unwrap().kind(), MessageKind::Question);
    f.settle(DEBOUNCE_MS).await;
    let b1 = f.claim("b").await;
    let prompt = f.prompt(&b1).await;
    assert!(prompt.contains("2 unread messages, 2 address you."));
    assert!(prompt.contains("type=\"note\" via=\"direct message\""));
    assert!(prompt.contains("type=\"question\" via=\"direct message\""));
    let mailbox = f
        .store
        .list_mailbox_messages(
            OPERATOR,
            &ListMailboxMessagesRequest {
                tag_id: "b".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages;
    assert_eq!(
        mailbox.iter().map(TagMessage::kind).collect::<Vec<_>>(),
        [MessageKind::Question, MessageKind::Note]
    );
    assert!(
        mailbox
            .iter()
            .all(|m| m.task_id.as_deref() == Some(b1.task_id.as_str()))
    );

    // A blocker is due at once: the send itself makes the inbox turn.
    f.send(&a0, "c", "Blocked on c", MessageKind::Blocker)
        .await
        .unwrap();
    let c1 = f.claim("c").await;
    assert!(f.prompt(&c1).await.contains("type=\"blocker\""));
    f.finish(&c1).await;
    // b's turn continues a's chain.
    f.send(&b1, "a", "Reply one", MessageKind::Note)
        .await
        .unwrap();
    f.finish(&b1).await;
    f.finish(&a0).await;
}

/// Wakes between a and b continuing one originating Task stop at three. Over the limit a note
/// waits and a question is delivered after an hour; the sender is told and the operator gets one
/// Inbox item.
async fn mutual_limit(f: &Fixture) {
    // a ← b (wake 2 of the pair, from typed_and_debounced) is due.
    f.settle(DEBOUNCE_MS).await;
    let a1 = f.claim("a").await;
    let third = f
        .send(&a1, "b", "Reply two", MessageKind::Note)
        .await
        .unwrap();
    assert_eq!(third.wake_deferred, "", "the third mutual wake is allowed");
    f.finish(&a1).await;
    f.settle(DEBOUNCE_MS).await;
    let b2 = f.claim("b").await;
    let held = f
        .send(&b2, "a", "Reply three", MessageKind::Note)
        .await
        .unwrap();
    assert!(held.message.is_some(), "the message is stored");
    assert!(
        held.wake_deferred
            .starts_with("a and b already woke each other 3 times for Task ")
            && held
                .wake_deferred
                .ends_with("; Tag a will see this message in its next turn."),
        "{}",
        held.wake_deferred
    );
    let late = f
        .send(&b2, "a", "Is this still on?", MessageKind::Question)
        .await
        .unwrap();
    assert!(
        late.wake_deferred
            .ends_with("; Tag a gets this question when the limit resets, within the hour."),
        "{}",
        late.wake_deferred
    );
    f.finish(&b2).await;
    f.settle(DEBOUNCE_MS).await;
    assert!(f.try_claim().await.is_none(), "the question waits");
    let pending = f.store.metrics().await.unwrap().mailbox.unwrap().pending;
    assert_eq!(pending, 1, "one deferred wake waits");

    let items = f.wake_limit_items().await;
    assert_eq!(items.len(), 1, "one item per tripped limit");
    assert!(items[0].key.starts_with("wake_limit:3:"));
    assert!(
        items[0]
            .reason
            .starts_with("a and b hit the mutual wake limit (3) for Task ")
            && items[0].reason.contains("; 2 messages waited."),
        "{}",
        items[0].reason
    );
    assert!(items[0].operator_eligible);

    // An hour later the question is delivered with the note that waited.
    f.settle(HOUR_MS).await;
    let a2 = f.claim("a").await;
    let prompt = f.prompt(&a2).await;
    assert!(prompt.contains("These messages waited for a wake limit: a and b already woke"));
    assert!(prompt.contains("Reply three") && prompt.contains("Is this still on?"));
    assert_eq!(prompt.matches("<tag-message ").count(), 2);
    f.finish(&a2).await;
    assert_eq!(f.wake_limit_items().await.len(), 1);
}

/// A Team may lower the hourly limit. A note over it waits for the Tag's next turn, which also
/// shows the notes another conversation's limit held back.
async fn hourly_limit_and_held_notes(f: &Fixture) {
    let team = f
        .set_limits(
            "hourly",
            TeamWakeLimits {
                per_tag_per_hour: Some(1),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(
        team.wake_limits,
        Some(TeamWakeLimits {
            per_tag_per_hour: Some(1),
            ..Default::default()
        })
    );
    f.settle(HOUR_MS).await;
    let a3 = f.ordinary("a").await;
    f.send(&a3, "d", "First for d", MessageKind::Note)
        .await
        .unwrap();
    f.settle(DEBOUNCE_MS).await;
    let d1 = f.claim("d").await;
    f.finish(&d1).await;
    let held = f
        .send(&a3, "d", "Second for d", MessageKind::Note)
        .await
        .unwrap();
    assert_eq!(
        held.wake_deferred,
        "Tag d was already woken once this hour by other Tags; Tag d will see this message in its next turn."
    );
    f.finish(&a3).await;
    f.settle(DEBOUNCE_MS).await;
    assert!(f.try_claim().await.is_none(), "the held note wakes nobody");
    let items = f.wake_limit_items().await;
    assert_eq!(items.len(), 2);
    assert!(items.iter().any(|item| {
        item.reason
            == "Tag d hit the hourly wake limit (1) for wakes by other Tags; 1 message waited. They are delivered late, never dropped. Raise the Team's spec.wakeLimits if this is expected."
    }));

    // The next hour b's note wakes d, and d's turn shows a's held note too.
    f.settle(HOUR_MS).await;
    let b3 = f.ordinary("b").await;
    f.send(&b3, "d", "From b", MessageKind::Note).await.unwrap();
    f.finish(&b3).await;
    f.settle(DEBOUNCE_MS).await;
    let d2 = f.claim("d").await;
    let prompt = f.prompt(&d2).await;
    assert!(prompt.contains("From b") && prompt.contains("Second for d"));
    assert!(
        !prompt.contains("First for d"),
        "delivered messages stay delivered"
    );
    assert!(prompt.contains("2 unread messages, 2 address you."));
    f.finish(&d2).await;
    let mailbox = f
        .store
        .list_mailbox_messages(
            OPERATOR,
            &ListMailboxMessagesRequest {
                tag_id: "d".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages;
    assert_eq!(mailbox.len(), 3);
    assert!(
        mailbox
            .iter()
            .all(|m| m.state() == TagMessageState::Handled)
    );
}

/// A direct message always wakes its recipient, within the limits, whatever its type: each type
/// writes a wake and starts an inbox turn that shows the type.
async fn every_type_wakes(f: &Fixture) {
    f.set_limits("every-type", TeamWakeLimits::default()).await;
    f.settle(HOUR_MS).await;
    let sent: [(&str, MessageKind, &str); 3] = [
        ("b", MessageKind::Evidence, "The parser tests pass"),
        ("c", MessageKind::Decision, "We ship on Friday"),
        ("d", MessageKind::Note, "The changelog is updated"),
    ];
    let a = f.ordinary("a").await;
    for (to, kind, text) in sent {
        let response = f.send(&a, to, text, kind).await.unwrap();
        assert_eq!(response.wake_deferred, "", "{to}");
        assert_eq!(response.message.unwrap().kind(), kind);
    }
    f.finish(&a).await;
    let pending = f.store.metrics().await.unwrap().mailbox.unwrap().pending;
    assert_eq!(pending, 3, "one wake per recipient");
    f.settle(DEBOUNCE_MS).await;
    for (to, kind, text) in sent {
        let turn = f.claim(to).await;
        let prompt = f.prompt(&turn).await;
        let name = match kind {
            MessageKind::Evidence => "evidence",
            MessageKind::Decision => "decision",
            _ => "note",
        };
        assert!(
            prompt.contains(&format!("type=\"{name}\" via=\"direct message\"")),
            "{prompt}"
        );
        assert!(prompt.contains(text), "{prompt}");
        f.finish(&turn).await;
    }
}

/// The Objective limit counts every Tag the Objective's Tags wake.
async fn objective_limit(f: &Fixture) {
    f.set_limits(
        "objective",
        TeamWakeLimits {
            per_objective_per_hour: Some(1),
            ..Default::default()
        },
    )
    .await;
    f.settle(HOUR_MS).await;
    let objective = f
        .store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "goal".into(),
                objective_id: "goal".into(),
                owner_tag_id: "a".into(),
                outcome: "Ship the release".into(),
                ongoing: true,
                team_id: Some("crew".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = f.claim("a").await;
    let first = f
        .send(&owner, "b", "Please build", MessageKind::Note)
        .await
        .unwrap();
    assert_eq!(first.wake_deferred, "");
    assert_eq!(
        first.message.unwrap().objective_id.as_deref(),
        Some(objective.objective_id.as_str())
    );
    let held = f
        .send(&owner, "c", "Please review", MessageKind::Note)
        .await
        .unwrap();
    assert_eq!(
        held.wake_deferred,
        "Objective goal already woke its Tags once this hour; Tag c will see this message in its next turn."
    );
    let item = f
        .wake_limit_items()
        .await
        .into_iter()
        .find(|item| item.key.starts_with("wake_limit:2:"))
        .unwrap();
    assert_eq!(item.objective_id, "goal");
    f.finish(&owner).await;
}

/// A Team's wake limits are stored, replaced whole, restored to the defaults, and bounded.
async fn team_overrides(f: &Fixture) {
    let team = f.set_limits("defaults", TeamWakeLimits::default()).await;
    assert_eq!(
        team.wake_limits, None,
        "an empty override restores the defaults"
    );
    let team = f
        .set_limits(
            "all",
            TeamWakeLimits {
                mutual_per_task: Some(0),
                per_tag_per_hour: Some(1000),
                per_objective_per_hour: Some(5),
            },
        )
        .await;
    assert_eq!(
        f.store
            .get_team(OPERATOR, "crew")
            .await
            .unwrap()
            .wake_limits,
        team.wake_limits
    );
    let refused = f
        .store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "too-high".into(),
                team_id: "too-high".into(),
                name: "Too high".into(),
                member_tag_ids: vec!["a".into()],
                wake_limits: Some(TeamWakeLimits {
                    mutual_per_task: Some(1001),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await;
    assert!(matches!(refused, Err(StoreError::InvalidArgument(_))));
    // A limit of zero allows no Tag-originated wake: the pair limit stops even the first one.
    let a5 = f.ordinary("a").await;
    let held = f
        .send(&a5, "b", "Never wakes", MessageKind::Note)
        .await
        .unwrap();
    assert!(
        held.wake_deferred
            .starts_with("a and b already woke each other 0 times for Task "),
        "{}",
        held.wake_deferred
    );
    f.finish(&a5).await;
}

#[tokio::test]
async fn sqlite_wake_limits_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("wakes.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_wake_limits_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_wake_limits_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL wake limits contract failed");
}
