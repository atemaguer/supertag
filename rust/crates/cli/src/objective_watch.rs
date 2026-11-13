//! `supertag watch objective ID`: one Objective's progress as a timeline, one line per event
//! with its time and actor, until the Objective closes (`tests/objective-watch.test.ts`).
//!
//! Each event is the difference between two reads of the Control Plane's Objective overview,
//! with every Task of the Objective not yet settled and every Team post after the last one
//! printed, each read a page at a time. Change notices wake the next read; a periodic read
//! covers a dropped notice stream, and a failed read is retried. Times are the recorded time
//! where there is one, else the time the change was read; each read's events print in time
//! order.
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use serde_json::{Value, json};
use supertag_control_plane::objective_limits::Timestamp;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        GetObjectiveOverviewRequest, ListWorkstreamPostsRequest, ListWorkstreamPostsResponse,
        ObjectiveOverview, ObjectiveSessionFailure, ObjectiveSessionStatus, ObjectiveStatus,
        ObjectiveTeamPost, TaskState, WatchKind, WatchRequest,
        objective_overviews_client::ObjectiveOverviewsClient,
        operator_events_client::OperatorEventsClient, teams_client::TeamsClient,
        watch_event::Update,
    },
};

use crate::{
    Connection,
    objective_overview::{delivery_summary, session_label},
    observe::Output,
    resolve_target,
    terminal::text as terminal_text,
};

/// Rereads the overview at least this often when no change notice arrives.
const POLL: Duration = Duration::from_secs(2);
/// Tasks per overview read; the largest page the overview returns.
const TASK_PAGE: u32 = 50;
const ACTOR_WIDTH: usize = 12;

/// One timeline entry.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Event {
    pub kind: &'static str,
    pub at_ms: i64,
    pub actor: String,
    pub message: String,
    /// Recorded text shown on its own lines under the headline, such as a failure.
    pub detail: Option<String>,
    /// Further fields of the JSON line.
    pub fields: BTreeMap<&'static str, Value>,
}

#[derive(Default, Clone, PartialEq)]
struct SeenSession {
    status: i32,
    latest_task_id: String,
    question: String,
    delivered_task_id: String,
}

/// What earlier reads already reported.
#[derive(Default)]
pub(crate) struct Timeline {
    started: bool,
    status: i32,
    sessions: BTreeMap<String, SeenSession>,
    last_post: u64,
    pending_approvals: u32,
    notices: BTreeSet<String>,
    /// Leading Tasks, in acceptance order, that are settled and reported; reads start after.
    task_offset: u32,
    /// What was last reported for each Task.
    reported: BTreeMap<String, &'static str>,
}

fn status_words(status: ObjectiveStatus) -> String {
    status
        .as_str_name()
        .trim_start_matches("OBJECTIVE_STATUS_")
        .to_ascii_lowercase()
        .replace('_', " ")
}

fn session_words(status: ObjectiveSessionStatus) -> &'static str {
    match status {
        ObjectiveSessionStatus::Queued => "is queued",
        ObjectiveSessionStatus::Running => "is running",
        ObjectiveSessionStatus::Waiting => "is waiting",
        ObjectiveSessionStatus::Succeeded => "finished",
        ObjectiveSessionStatus::Failed => "failed",
        ObjectiveSessionStatus::Cancelled => "was cancelled",
        ObjectiveSessionStatus::Uncertain => "is uncertain",
        ObjectiveSessionStatus::NotStarted | ObjectiveSessionStatus::Unspecified => "is pending",
    }
}

/// How a turn that is no longer a Session's latest ended; `None` while it may still change.
fn turn_words(state: TaskState) -> Option<&'static str> {
    match state {
        TaskState::Succeeded => Some("finished"),
        TaskState::Failed => Some("failed"),
        TaskState::Cancelled => Some("was cancelled"),
        TaskState::Uncertain => Some("is uncertain"),
        _ => None,
    }
}

/// Explain a turn that did not succeed under its headline and in its JSON line.
fn explain(entry: &mut Event, failure: &ObjectiveSessionFailure) {
    if !failure.message.trim().is_empty() {
        entry.detail = Some(failure.message.trim().to_owned());
        entry.fields.insert("failure", json!(failure.message));
    }
    entry
        .fields
        .insert("harness_kind", json!(failure.harness_kind().as_str_name()));
    entry
        .fields
        .insert("next_actions", json!(failure.next_actions));
}

fn first_line(text: &str) -> String {
    text.trim().lines().next().unwrap_or("").trim().to_owned()
}

/// Whether the Objective is closed and no Session is still recording its turn.
pub(crate) fn settled(view: &ObjectiveOverview) -> bool {
    closed(view)
        && view.sessions.iter().all(|session| {
            !matches!(
                session.status(),
                ObjectiveSessionStatus::Queued | ObjectiveSessionStatus::Running
            )
        })
}

pub(crate) fn closed(view: &ObjectiveOverview) -> bool {
    view.objective.as_ref().is_some_and(|objective| {
        matches!(
            objective.status(),
            ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
        )
    })
}

impl Timeline {
    /// The Task offset the next overview read starts at.
    pub(crate) fn task_offset(&self) -> u32 {
        self.task_offset
    }

    /// The newest Team post already reported.
    pub(crate) fn last_post(&self) -> u64 {
        self.last_post
    }

    /// The events between the previous read and this one, oldest first. `view.tasks` starts at
    /// [`Timeline::task_offset`] and `view.posts` holds the posts after [`Timeline::last_post`].
    pub(crate) fn events(&mut self, view: &ObjectiveOverview) -> Vec<Event> {
        let mut events = self.changes(view);
        // Closing comes last: the turns it cancels are recorded just after it.
        events.sort_by_key(|event| (event.kind == "objective.closed", event.at_ms));
        events
    }

    fn changes(&mut self, view: &ObjectiveOverview) -> Vec<Event> {
        let Some(objective) = &view.objective else {
            return vec![];
        };
        let id = &objective.objective_id;
        let now = view.as_of_ms;
        let mut events = vec![];
        let event = |kind, at_ms: i64, actor: &str, message: String| Event {
            kind,
            at_ms,
            actor: actor.to_owned(),
            message,
            detail: None,
            fields: BTreeMap::new(),
        };
        if !self.started {
            self.started = true;
            self.status = ObjectiveStatus::Working as i32;
            events.push(event(
                "objective.created",
                view.objective_created_at_ms,
                "operator",
                format!(
                    "Objective {id} created for {}: {}",
                    objective.owner_tag_id,
                    first_line(&objective.outcome)
                ),
            ));
        }
        for session in &view.sessions {
            let label = session_label(session);
            let seen = self.sessions.get(&session.session_id).cloned();
            if seen.is_none() && !session.owner {
                events.push(event(
                    "session.started",
                    session.started_at_ms.unwrap_or(now),
                    &session.tag_id,
                    format!("Started {label}"),
                ));
            }
            let seen = seen.unwrap_or_default();
            let changed = session.status != seen.status
                || session.latest_task_id != seen.latest_task_id
                || session.question != seen.question;
            if changed && !session.latest_task_id.is_empty() {
                let status = session.status();
                let at = match status {
                    ObjectiveSessionStatus::Queued | ObjectiveSessionStatus::Running => now,
                    _ => session.latest_completed_at_ms.unwrap_or(now),
                };
                let mut message = format!(
                    "{label}: Task {} {}",
                    session.latest_task_id,
                    session_words(status)
                );
                if !session.question.is_empty() {
                    message += &format!(": {}", first_line(&session.question));
                }
                let mut entry = event("task.status", at, &session.tag_id, message);
                entry
                    .fields
                    .insert("task_id", json!(session.latest_task_id));
                entry.fields.insert("session_id", json!(session.session_id));
                entry.fields.insert(
                    "status",
                    json!(
                        status
                            .as_str_name()
                            .trim_start_matches("OBJECTIVE_SESSION_STATUS_")
                            .to_ascii_lowercase()
                    ),
                );
                if let Some(failure) = session
                    .failure
                    .as_ref()
                    .filter(|failure| failure.task_id == session.latest_task_id)
                {
                    explain(&mut entry, failure);
                }
                events.push(entry);
                self.reported
                    .insert(session.latest_task_id.clone(), session_words(status));
            }
            let delivered = session
                .delivery
                .as_ref()
                .map(|delivery| delivery.task_id.clone())
                .unwrap_or_default();
            if let Some(delivery) = &session.delivery
                && delivered != seen.delivered_task_id
            {
                let mut entry = event(
                    "task.delivered",
                    session.latest_completed_at_ms.unwrap_or(now),
                    &session.tag_id,
                    format!(
                        "{label}: Task {} delivered {}",
                        delivery.task_id,
                        delivery_summary(delivery)
                    ),
                );
                entry.fields.insert("task_id", json!(delivery.task_id));
                entry
                    .fields
                    .insert("workspace_id", json!(delivery.workspace_id));
                entry
                    .fields
                    .insert("head_commit", json!(delivery.head_commit));
                entry
                    .fields
                    .insert("changed_files", json!(delivery.changed_files));
                events.push(entry);
            }
            self.sessions.insert(
                session.session_id.clone(),
                SeenSession {
                    status: session.status,
                    latest_task_id: session.latest_task_id.clone(),
                    question: session.question.clone(),
                    delivered_task_id: delivered,
                },
            );
        }
        // Earlier turns that ended between two reads, each once in the way it ended.
        let latest: BTreeSet<&str> = view
            .sessions
            .iter()
            .map(|session| session.latest_task_id.as_str())
            .collect();
        for turn in &view.tasks {
            let state = turn.state();
            let Some(words) = turn_words(state) else {
                continue;
            };
            if latest.contains(turn.task_id.as_str())
                || self.reported.get(&turn.task_id) == Some(&words)
            {
                continue;
            }
            let label = view
                .sessions
                .iter()
                .find(|session| {
                    session.session_id == turn.session_id && session.tag_id == turn.tag_id
                })
                .map_or_else(|| format!("Session {}", turn.session_id), session_label);
            let mut entry = event(
                "task.status",
                turn.completed_at_ms.unwrap_or(now),
                &turn.tag_id,
                format!("{label}: Task {} {words}", turn.task_id),
            );
            entry.fields.insert("task_id", json!(turn.task_id));
            entry.fields.insert("session_id", json!(turn.session_id));
            entry.fields.insert(
                "status",
                json!(match state {
                    TaskState::Succeeded => "succeeded",
                    TaskState::Failed => "failed",
                    TaskState::Cancelled => "cancelled",
                    _ => "uncertain",
                }),
            );
            if let Some(failure) = &turn.failure {
                explain(&mut entry, failure);
            }
            events.push(entry);
            self.reported.insert(turn.task_id.clone(), words);
        }
        // Reads start after the leading Tasks that ended and were reported as they ended.
        for turn in &view.tasks {
            let settled = matches!(
                turn.state(),
                TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
            ) && self.reported.get(&turn.task_id).copied()
                == turn_words(turn.state());
            if !settled {
                break;
            }
            self.task_offset += 1;
        }
        let after = self.last_post;
        for post in view.posts.iter().filter(|post| post.sequence > after) {
            let to = if post.to_tag_ids.is_empty() {
                "the Team".to_owned()
            } else {
                post.to_tag_ids.join(", ")
            };
            let mut entry = event(
                "team.post",
                post.created_at_ms,
                &post.author_tag_id,
                format!("Posted to {to}: {}", first_line(&post.body)),
            );
            entry.fields.insert("sequence", json!(post.sequence));
            events.push(entry);
            self.last_post = post.sequence;
        }
        if view.pending_approvals != self.pending_approvals {
            if view.pending_approvals > 0 {
                let mut entry = event(
                    "approvals.pending",
                    now,
                    "supertag",
                    format!(
                        "{} approval request{} wait for a decision: supertag get approvals",
                        view.pending_approvals,
                        if view.pending_approvals == 1 { "" } else { "s" }
                    ),
                );
                entry
                    .fields
                    .insert("pending", json!(view.pending_approvals));
                events.push(entry);
            }
            self.pending_approvals = view.pending_approvals;
        }
        for notice in &view.notices {
            if self.notices.insert(notice.key.clone()) {
                events.push(event(
                    "objective.limit",
                    notice.at_ms,
                    "supertag",
                    first_line(&notice.message),
                ));
            }
        }
        if objective.status != self.status {
            self.status = objective.status;
            let status = objective.status();
            let mut entry = match status {
                ObjectiveStatus::Completed | ObjectiveStatus::Cancelled => {
                    let at = objective
                        .cancelled_at_ms
                        .filter(|_| status == ObjectiveStatus::Cancelled)
                        .unwrap_or(view.objective_updated_at_ms);
                    let mut message = format!("Objective {}", status_words(status));
                    if let Some(reason) = objective
                        .cancellation_reason
                        .as_deref()
                        .filter(|_| status == ObjectiveStatus::Cancelled)
                    {
                        message += &format!(": {}", first_line(reason));
                    }
                    event("objective.closed", at, "operator", message)
                }
                _ => event(
                    "objective.status",
                    view.objective_updated_at_ms,
                    &objective.owner_tag_id,
                    format!("Objective is {}", status_words(status)),
                ),
            };
            entry.fields.insert(
                "status",
                json!(
                    status
                        .as_str_name()
                        .trim_start_matches("OBJECTIVE_STATUS_")
                        .to_ascii_lowercase()
                ),
            );
            events.push(entry);
        }
        events
    }
}

/// `2026-11-07 00:00:10Z`.
fn short_time(ms: i64) -> String {
    let full = Timestamp::from_millis(ms).map_or_else(|| ms.to_string(), |at| at.to_string());
    match (full.get(..10), full.get(11..19)) {
        (Some(day), Some(time)) => format!("{day} {time}Z"),
        _ => full,
    }
}

pub(crate) fn text_line(event: &Event) -> String {
    let mut line = format!(
        "{}  {:ACTOR_WIDTH$}  {}",
        short_time(event.at_ms),
        terminal_text(&event.actor),
        terminal_text(&event.message)
    );
    if let Some(detail) = &event.detail {
        for part in detail.lines() {
            line.push_str(&format!(
                "\n{:width$}{}",
                "",
                terminal_text(part.trim_end()),
                width = 20 + 2 + ACTOR_WIDTH + 2 + 2
            ));
        }
    }
    line
}

pub(crate) fn json_line(objective_id: &str, event: &Event) -> Value {
    let mut value = json!({
        "kind": event.kind,
        "objective_id": objective_id,
        "at": Timestamp::from_millis(event.at_ms).map(|at| at.to_string()),
        "actor": event.actor,
        "message": match &event.detail {
            Some(detail) => format!("{}: {}", event.message, first_line(detail)),
            None => event.message.clone(),
        },
    });
    for (key, field) in &event.fields {
        value[*key] = field.clone();
    }
    value
}

/// The closing summary: the result and what each Session delivered.
pub(crate) fn summary(view: &ObjectiveOverview) -> String {
    let Some(objective) = &view.objective else {
        return String::new();
    };
    let mut lines = vec![
        String::new(),
        format!(
            "Objective {} is {}.",
            objective.objective_id,
            status_words(objective.status())
        ),
    ];
    if let Some(result) = objective
        .completion_summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
    {
        lines.push(format!("Result: {}", first_line(result)));
    }
    let delivered: Vec<_> = view
        .sessions
        .iter()
        .filter_map(|session| {
            session
                .delivery
                .as_ref()
                .map(|delivery| (session, delivery))
        })
        .collect();
    if !delivered.is_empty() {
        lines.push("Delivered:".into());
        for (session, delivery) in delivered {
            lines.push(format!("  {} ({})", session_label(session), session.tag_id));
            lines.push(format!("    {}", delivery_summary(delivery)));
        }
    }
    lines
        .iter()
        .map(|line| terminal_text(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every post one read returns, following its cursor a page at a time.
async fn all_posts(
    mut page: impl AsyncFnMut(String) -> Result<ListWorkstreamPostsResponse>,
) -> Result<Vec<ObjectiveTeamPost>> {
    let mut posts = vec![];
    let mut cursor = String::new();
    loop {
        let next = page(cursor).await?;
        posts.extend(next.posts.into_iter().map(|post| ObjectiveTeamPost {
            sequence: post.sequence,
            author_tag_id: post.author_tag_id,
            to_tag_ids: post.to_tag_ids,
            body: post.body,
            created_at_ms: post.created_at_ms,
        }));
        if next.next_cursor.is_empty() {
            return Ok(posts);
        }
        cursor = next.next_cursor;
    }
}

/// Wait, then read, until a read succeeds. A failed read is reported once per run of
/// failures and read again after the next wait instead of ending the watch.
async fn reread<T>(
    mut wait: impl AsyncFnMut(),
    mut read: impl AsyncFnMut() -> Result<T>,
    mut failed: impl FnMut(&anyhow::Error),
) -> T {
    let mut reported = false;
    loop {
        wait().await;
        match read().await {
            Ok(value) => return value,
            Err(error) => {
                if !std::mem::replace(&mut reported, true) {
                    failed(&error);
                }
            }
        }
    }
}

/// Read the overview with every Task from `task_offset` on and every Team post after
/// `after_post`, each a page at a time.
async fn read(
    overviews: &mut ObjectiveOverviewsClient<ProtocolChannel>,
    teams: &mut TeamsClient<ProtocolChannel>,
    token: &str,
    objective_id: &str,
    task_offset: u32,
    after_post: u64,
) -> Result<ObjectiveOverview> {
    let mut page = async |offset: u32| -> Result<ObjectiveOverview> {
        Ok(overviews
            .get_objective_overview(authenticated_request(
                GetObjectiveOverviewRequest {
                    objective_id: objective_id.to_owned(),
                    limit: TASK_PAGE,
                    offset,
                },
                token,
                None,
            )?)
            .await?
            .into_inner())
    };
    let mut view = page(task_offset).await?;
    let mut next = view.next_offset;
    while let Some(offset) = next {
        let more = page(offset).await?;
        view.tasks.extend(more.tasks);
        next = more.next_offset.filter(|next| *next > offset);
    }
    view.posts = match view.team.as_ref().map(|team| team.team_id.clone()) {
        Some(team) => {
            all_posts(async |cursor| {
                Ok(teams
                    .list_workstream_posts(authenticated_request(
                        ListWorkstreamPostsRequest {
                            team: team.clone(),
                            after_sequence: Some(after_post),
                            limit: 0,
                            cursor,
                        },
                        token,
                        None,
                    )?)
                    .await?
                    .into_inner())
            })
            .await?
        }
        None => vec![],
    };
    Ok(view)
}

/// Follows one Objective until it closes and every running Session has recorded its turn, or
/// until `settle` passes after it closed.
pub(crate) async fn watch(
    connection: Connection,
    objective_id: String,
    output: Output,
    settle: Duration,
) -> Result<()> {
    let target = resolve_target(connection)?;
    let channel = crate::network::operator_channel(&target.endpoint(POLL * 5).await?).await?;
    let mut overviews = ObjectiveOverviewsClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut teams = TeamsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut timeline = Timeline::default();
    // An Objective that cannot be read fails at once, before any stream opens.
    let mut view = read(
        &mut overviews,
        &mut teams,
        &target.token,
        &objective_id,
        0,
        0,
    )
    .await?;
    let changed = Arc::new(tokio::sync::Notify::new());
    let notices = tokio::spawn(follow_changes(
        target.clone(),
        objective_id.clone(),
        changed.clone(),
    ));
    let mut closed_at: Option<tokio::time::Instant> = None;
    let outcome = async {
        loop {
            for event in timeline.events(&view) {
                match output {
                    Output::Text => outln!("{}", text_line(&event)),
                    Output::Json => crate::terminal::print_json(&json_line(&objective_id, &event))?,
                }
            }
            if closed(&view) {
                let since = *closed_at.get_or_insert_with(tokio::time::Instant::now);
                if settled(&view) || since.elapsed() >= settle {
                    if output == Output::Text {
                        outln!("{}", summary(&view));
                    }
                    return Ok(());
                }
            }
            // A failed read is read again after the next notice or tick, so a Control Plane
            // restart or a network outage does not end the watch.
            let (task_offset, after_post) = (timeline.task_offset(), timeline.last_post());
            view = reread(
                async || {
                    tokio::select! {
                        () = changed.notified() => {}
                        () = tokio::time::sleep(POLL) => {}
                    }
                },
                async || {
                    read(
                        &mut overviews,
                        &mut teams,
                        &target.token,
                        &objective_id,
                        task_offset,
                        after_post,
                    )
                    .await
                },
                |error| errln!("Could not read Objective {objective_id}; retrying: {error:#}"),
            )
            .await;
        }
    }
    .await;
    notices.abort();
    outcome
}

/// Wakes the timeline on every change notice that may concern the Objective. Reconnects from
/// the last resume token; the periodic read covers the time a stream is down.
async fn follow_changes(
    target: crate::OperatorTarget,
    objective_id: String,
    changed: Arc<tokio::sync::Notify>,
) {
    let kinds = [
        WatchKind::Objective,
        WatchKind::Task,
        WatchKind::WorkstreamPost,
    ]
    .map(|kind| kind as i32)
    .to_vec();
    let mut resume = String::new();
    loop {
        let stream = async {
            let channel = crate::network::operator_channel(
                &target
                    .endpoint(Duration::from_secs(u32::MAX as u64))
                    .await?,
            )
            .await?;
            let mut stream = OperatorEventsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .watch(authenticated_request(
                    WatchRequest {
                        resume_token: resume.clone(),
                        kinds: kinds.clone(),
                    },
                    &target.token,
                    None,
                )?)
                .await?
                .into_inner();
            while let Some(event) = stream.message().await? {
                resume.clone_from(&event.resume_token);
                match event.update {
                    Some(Update::Change(change))
                        if change.objective_id.is_empty()
                            || change.objective_id == objective_id =>
                    {
                        changed.notify_one();
                    }
                    Some(Update::Resync(_)) => changed.notify_one(),
                    _ => {}
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        drop(stream);
        tokio::time::sleep(POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{
        HarnessKind, Objective, ObjectiveSessionDelivery, ObjectiveSessionView, ObjectiveTurn,
    };

    const AT: i64 = 1_794_009_600_000; // 2026-11-07T00:00:00Z

    fn owner(status: ObjectiveSessionStatus) -> ObjectiveSessionView {
        ObjectiveSessionView {
            session_id: "session-owner".into(),
            tag_id: "planner".into(),
            owner: true,
            status: status as i32,
            task_count: 1,
            latest_task_id: "task-start".into(),
            latest_completed_at_ms: Some(AT + 10_000),
            ..Default::default()
        }
    }

    fn build(status: ObjectiveSessionStatus) -> ObjectiveSessionView {
        ObjectiveSessionView {
            session_id: "session-build".into(),
            tag_id: "builder".into(),
            title: "Build the exporter".into(),
            parent_session_id: "session-owner".into(),
            status: status as i32,
            task_count: 1,
            latest_task_id: "task-build".into(),
            ..Default::default()
        }
    }

    fn view(status: ObjectiveStatus, sessions: Vec<ObjectiveSessionView>) -> ObjectiveOverview {
        ObjectiveOverview {
            objective: Some(Objective {
                objective_id: "ship-sso".into(),
                owner_tag_id: "planner".into(),
                outcome: "Ship SSO for the admin console".into(),
                status: status as i32,
                ..Default::default()
            }),
            objective_created_at_ms: AT,
            objective_updated_at_ms: AT + 50_000,
            as_of_ms: AT + 20_000,
            sessions,
            ..Default::default()
        }
    }

    fn lines(timeline: &mut Timeline, view: &ObjectiveOverview) -> Vec<String> {
        timeline.events(view).iter().map(text_line).collect()
    }

    #[test]
    fn streams_one_line_per_event_with_time_and_actor_until_the_objective_closes() {
        let mut timeline = Timeline::default();
        let first = lines(
            &mut timeline,
            &view(
                ObjectiveStatus::Working,
                vec![owner(ObjectiveSessionStatus::Succeeded)],
            ),
        );
        assert_eq!(
            first,
            [
                "2026-11-07 00:00:00Z  operator      Objective ship-sso created for planner: Ship SSO for the admin console",
                "2026-11-07 00:00:10Z  planner       Objective conversation: Task task-start finished",
            ]
        );
        let started = lines(
            &mut timeline,
            &view(
                ObjectiveStatus::Working,
                vec![
                    owner(ObjectiveSessionStatus::Succeeded),
                    build(ObjectiveSessionStatus::Running),
                ],
            ),
        );
        assert_eq!(
            started,
            [
                "2026-11-07 00:00:20Z  builder       Started Build the exporter",
                "2026-11-07 00:00:20Z  builder       Build the exporter: Task task-build is running",
            ]
        );
        let mut built = build(ObjectiveSessionStatus::Succeeded);
        built.latest_completed_at_ms = Some(AT + 40_000);
        built.delivery = Some(ObjectiveSessionDelivery {
            task_id: "task-build".into(),
            workspace_id: "product".into(),
            base_commit: "fedcba9876543210".into(),
            head_commit: "0123456789abcdef0123".into(),
            committed: true,
            changed_files: 3,
            patch: true,
        });
        let mut closed = view(
            ObjectiveStatus::Completed,
            vec![owner(ObjectiveSessionStatus::Succeeded), built],
        );
        closed.objective.as_mut().unwrap().completion_summary =
            Some("SSO ships behind a flag.".into());
        let last = lines(&mut timeline, &closed);
        assert_eq!(
            last,
            [
                "2026-11-07 00:00:40Z  builder       Build the exporter: Task task-build finished",
                "2026-11-07 00:00:40Z  builder       Build the exporter: Task task-build delivered Commit 0123456789ab in Workspace product, 3 changed files since fedcba987654",
                "2026-11-07 00:00:50Z  operator      Objective completed",
            ]
        );
        assert!(settled(&closed));
        let summary = summary(&closed);
        assert!(
            summary.contains("Objective ship-sso is completed."),
            "{summary}"
        );
        assert!(summary.contains("Result: SSO ships behind a flag."));
        assert!(summary.contains("Build the exporter (builder)"));
        assert!(summary.contains("Commit 0123456789ab in Workspace product, 3 changed files"));
        // Nothing repeats on a read without changes.
        assert!(timeline.events(&closed).is_empty());
    }

    #[test]
    fn a_closed_objective_with_a_running_session_waits_for_its_delivery() {
        let closed = view(
            ObjectiveStatus::Cancelled,
            vec![
                owner(ObjectiveSessionStatus::Succeeded),
                build(ObjectiveSessionStatus::Running),
            ],
        );
        assert!(super::closed(&closed));
        assert!(!settled(&closed));
    }

    #[test]
    fn explains_a_failed_turn_on_its_own_lines_and_keeps_the_message_in_json() {
        let mut failed = owner(ObjectiveSessionStatus::Failed);
        failed.latest_completed_at_ms = None;
        failed.failure = Some(ObjectiveSessionFailure {
            task_id: "task-start".into(),
            state: TaskState::Failed as i32,
            harness_kind: HarnessKind::Codex as i32,
            message: "The harness is not signed in.\nRun codex login.".into(),
            next_actions: vec!["supertag task events task-start".into()],
        });
        let mut timeline = Timeline::default();
        let events = timeline.events(&view(ObjectiveStatus::Working, vec![failed]));
        let text = text_line(&events[1]);
        let mut parts = text.lines();
        assert_eq!(
            parts.next(),
            Some(
                "2026-11-07 00:00:20Z  planner       Objective conversation: Task task-start failed"
            )
        );
        assert_eq!(
            parts.next().map(str::trim),
            Some("The harness is not signed in.")
        );
        assert_eq!(parts.next().map(str::trim), Some("Run codex login."));
        let json = json_line("ship-sso", &events[1]);
        assert_eq!(json["kind"], "task.status");
        assert_eq!(json["status"], "failed");
        assert_eq!(
            json["failure"],
            "The harness is not signed in.\nRun codex login."
        );
        assert_eq!(json["harness_kind"], "HARNESS_KIND_CODEX");
        assert_eq!(
            json["message"],
            "Objective conversation: Task task-start failed: The harness is not signed in."
        );
        assert_eq!(json["objective_id"], "ship-sso");
    }

    #[test]
    fn shows_questions_posts_approvals_and_closing_reasons() {
        let mut asking = owner(ObjectiveSessionStatus::Waiting);
        asking.question = "Which region first?".into();
        let mut first = view(ObjectiveStatus::Working, vec![asking]);
        first.posts = vec![ObjectiveTeamPost {
            sequence: 1,
            author_tag_id: "builder".into(),
            to_tag_ids: vec!["planner".into()],
            body: "Exporter ready\nDetails follow".into(),
            created_at_ms: AT + 5_000,
        }];
        first.pending_approvals = 2;
        let mut timeline = Timeline::default();
        let text = lines(&mut timeline, &first).join("\n");
        assert!(text.contains(
            "planner       Objective conversation: Task task-start is waiting: Which region first?"
        ));
        assert!(
            text.contains("2026-11-07 00:00:05Z  builder       Posted to planner: Exporter ready")
        );
        assert!(text.contains(
            "supertag      2 approval requests wait for a decision: supertag get approvals"
        ));
        let mut cancelled = first.clone();
        let objective = cancelled.objective.as_mut().unwrap();
        objective.status = ObjectiveStatus::Cancelled as i32;
        objective.cancelled_at_ms = Some(AT + 120_000);
        objective.cancellation_reason = Some("Superseded\nby another plan".into());
        let text = lines(&mut timeline, &cancelled).join("\n");
        assert_eq!(
            text,
            "2026-11-07 00:02:00Z  operator      Objective cancelled: Superseded"
        );
        assert!(!summary(&cancelled).contains("Delivered:"));
    }

    #[test]
    fn prints_turns_that_ended_between_two_reads_in_time_order() {
        let mut timeline = Timeline::default();
        let mut started = build(ObjectiveSessionStatus::Running);
        started.started_at_ms = Some(AT + 12_000);
        lines(
            &mut timeline,
            &view(
                ObjectiveStatus::Working,
                vec![owner(ObjectiveSessionStatus::Succeeded), started.clone()],
            ),
        );
        // Between two reads the build turn failed and the next turn started.
        let mut next = started;
        next.latest_task_id = "task-build-2".into();
        let mut later = view(
            ObjectiveStatus::Working,
            vec![owner(ObjectiveSessionStatus::Succeeded), next],
        );
        later.as_of_ms = AT + 30_000;
        let turn = |task_id: &str, state: TaskState, at: i64| ObjectiveTurn {
            task_id: task_id.into(),
            tag_id: "builder".into(),
            session_id: "session-build".into(),
            state: state as i32,
            completed_at_ms: Some(at),
            ..Default::default()
        };
        let mut failed = turn("task-build", TaskState::Failed, AT + 25_000);
        failed.failure = Some(ObjectiveSessionFailure {
            task_id: "task-build".into(),
            state: TaskState::Failed as i32,
            message: "Tests failed.".into(),
            next_actions: vec!["supertag task events task-build".into()],
            ..Default::default()
        });
        later.tasks = vec![
            turn("task-start", TaskState::Succeeded, AT + 10_000),
            failed,
            turn("task-build-2", TaskState::Running, 0),
        ];
        let text = lines(&mut timeline, &later).join("\n");
        assert_eq!(
            text,
            format!(
                "2026-11-07 00:00:25Z  builder       Build the exporter: Task task-build failed\n\
                 {:38}Tests failed.\n\
                 2026-11-07 00:00:30Z  builder       Build the exporter: Task task-build-2 is running",
                ""
            )
        );
        // Settled turns are not read again, and nothing repeats.
        assert_eq!(timeline.task_offset(), 2);
        later.tasks.drain(..2);
        assert!(timeline.events(&later).is_empty());
    }

    #[test]
    fn a_session_starts_at_its_recorded_time() {
        let mut timeline = Timeline::default();
        let mut started = build(ObjectiveSessionStatus::Running);
        started.started_at_ms = Some(AT + 5_000);
        let mut replay = view(
            ObjectiveStatus::Working,
            vec![owner(ObjectiveSessionStatus::Succeeded), started],
        );
        replay.as_of_ms = AT + 86_400_000;
        let text = lines(&mut timeline, &replay);
        assert_eq!(
            text[1],
            "2026-11-07 00:00:05Z  builder       Started Build the exporter"
        );
        assert!(text[2].contains("Objective conversation: Task task-start finished"));
    }

    fn post(sequence: u64) -> supertag_protocol::v2::WorkstreamPost {
        supertag_protocol::v2::WorkstreamPost {
            sequence,
            author_tag_id: "builder".into(),
            body: format!("Update {sequence}"),
            created_at_ms: AT + sequence as i64 * 1_000,
            ..Default::default()
        }
    }

    /// A Team's posts after `after`, 16 to a page, as `ListWorkstreamPosts` pages them.
    fn page(all: &[u64], after: u64, cursor: &str) -> ListWorkstreamPostsResponse {
        let after = cursor
            .strip_prefix('s')
            .map_or(after, |value| value.parse().unwrap());
        let rest: Vec<_> = all
            .iter()
            .copied()
            .filter(|sequence| *sequence > after)
            .collect();
        let posts: Vec<_> = rest.iter().take(16).copied().map(post).collect();
        ListWorkstreamPostsResponse {
            next_cursor: if rest.len() > 16 {
                format!("s{}", posts.last().unwrap().sequence)
            } else {
                String::new()
            },
            posts,
        }
    }

    #[tokio::test]
    async fn replays_every_team_post_a_page_at_a_time_and_prints_each_burst_in_full() {
        let mut timeline = Timeline::default();
        let mut sequences: Vec<u64> = (1..=120).collect();
        let mut printed = vec![];
        for burst in [120, 250] {
            sequences.extend(sequences.len() as u64 + 1..=burst);
            let after = timeline.last_post();
            let mut reads = 0;
            let posts = all_posts(async |cursor| {
                reads += 1;
                Ok(page(&sequences, after, &cursor))
            })
            .await
            .unwrap();
            assert!(reads > 1, "one page holds 16 posts");
            let mut read = view(ObjectiveStatus::Working, vec![]);
            read.posts = posts;
            printed.extend(
                timeline
                    .events(&read)
                    .into_iter()
                    .filter(|event| event.kind == "team.post")
                    .map(|event| event.message),
            );
        }
        assert_eq!(printed.len(), 250);
        for sequence in [1, 50, 120, 121, 250] {
            assert_eq!(
                printed
                    .iter()
                    .filter(|message| **message == format!("Posted to the Team: Update {sequence}"))
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn rereads_after_a_failed_read_instead_of_ending() {
        let mut reads = 0;
        let mut waits = 0;
        let mut failures = vec![];
        let value = reread(
            async || waits += 1,
            async || {
                reads += 1;
                if reads < 3 {
                    anyhow::bail!("unavailable")
                }
                Ok(reads)
            },
            |error| failures.push(error.to_string()),
        )
        .await;
        assert_eq!(value, 3);
        assert_eq!(waits, 3, "each read waits for a notice or the next tick");
        assert_eq!(
            failures,
            ["unavailable"],
            "a run of failures is reported once"
        );
    }

    #[test]
    fn agent_text_cannot_drive_the_terminal() {
        let mut asking = owner(ObjectiveSessionStatus::Waiting);
        asking.question = "Pick\u{1b}[2J one".into();
        let mut timeline = Timeline::default();
        let text = lines(&mut timeline, &view(ObjectiveStatus::Working, vec![asking])).join("\n");
        assert!(!text.contains('\u{1b}'), "{text}");
    }
}
