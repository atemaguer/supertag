//! `supertag describe objective`: the Control Plane's Objective overview as
//! readable text or as JSON. Rendering only: every state, count, and next
//! action comes from the overview.
use serde_json::{Value, json};
use supertag_control_plane::objective_limits::Timestamp;
use supertag_protocol::v2::{
    HarnessKind, ObjectiveAttentionKind, ObjectiveBudgetMeasure, ObjectiveOverview,
    ObjectiveSessionDelivery, ObjectiveSessionFailure, ObjectiveSessionStatus,
    ObjectiveSessionView, ObjectiveStatus, ObjectiveTurn, TaskState,
};

use crate::observe::money;
use crate::terminal::text as terminal_text;

fn words(name: &str, prefix: &str) -> String {
    name.strip_prefix(prefix)
        .unwrap_or(name)
        .to_ascii_lowercase()
        .replace('_', " ")
}

fn status_words(status: ObjectiveStatus) -> String {
    words(status.as_str_name(), "OBJECTIVE_STATUS_")
}

fn session_words(status: ObjectiveSessionStatus) -> String {
    words(status.as_str_name(), "OBJECTIVE_SESSION_STATUS_")
}

fn task_words(state: TaskState) -> String {
    words(state.as_str_name(), "TASK_STATE_")
}

fn time(ms: i64) -> String {
    Timestamp::from_millis(ms).map_or_else(|| ms.to_string(), |at| at.to_string())
}

fn plural(count: u64, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// The first line of agent-authored text, bounded for one terminal row.
fn first_line(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() > 100 {
        let mut cut: String = line.chars().take(99).collect();
        cut.push('…');
        cut
    } else {
        line.to_owned()
    }
}

/// Indents every line after the first, keeping each line free of controls.
fn block(text: &str, indent: &str) -> String {
    text.trim()
        .lines()
        .map(|line| terminal_text(&line.replace('\t', "  ")))
        .collect::<Vec<_>>()
        .join(&format!("\n{indent}"))
}

fn budget_line(view: &ObjectiveOverview) -> String {
    let Some(pool) = &view.pool else {
        return "Budget: unlimited".into();
    };
    let amount = |minor: u64| match &pool.currency {
        Some(currency) => money(minor, currency),
        None => format!("{minor} units"),
    };
    let unknown = if pool.unknown_cost_attempts > 0 {
        format!(
            "; {} with unknown cost, so the budget cannot count {}",
            plural(u64::from(pool.unknown_cost_attempts), "Task Attempt"),
            if pool.unknown_cost_attempts == 1 {
                "it"
            } else {
                "them"
            }
        )
    } else {
        String::new()
    };
    match pool.measure() {
        ObjectiveBudgetMeasure::Unmeasured => format!(
            "Budget: {}; no currency, so no spend counts against it",
            amount(pool.limit_minor.unwrap_or_default())
        ),
        ObjectiveBudgetMeasure::ProviderReportedCost => {
            let limit = pool.limit_minor.unwrap_or_default();
            let spent = pool.spent_minor.unwrap_or_default();
            let mut line = format!("Budget: {} of {} spent", amount(spent), amount(limit));
            if pool.overrun_minor > 0 {
                line.push_str(&format!("; overrun {}", amount(pool.overrun_minor)));
            } else if pool.exhausted {
                line.push_str("; exhausted");
            }
            line + &unknown
        }
        _ => match pool.spent_minor.filter(|spent| *spent > 0) {
            Some(spent) => format!(
                "Budget: unlimited; {} from recorded usage{unknown}",
                amount(spent)
            ),
            None => format!("Budget: unlimited; no cost recorded{unknown}"),
        },
    }
}

fn turn_from(turn: &ObjectiveTurn, owner: &str) -> &'static str {
    match turn.kind.as_str() {
        "start" | "notice" | "resume" | "idle" => "SuperTag",
        "report" => "Work Session report",
        _ if turn.tag_id == owner => "message",
        _ => "work",
    }
}

/// Readable overview. Leads with what a person decides on: status, outcome,
/// result, owner, limits, and what needs them; then the work.
pub(crate) fn text(view: &ObjectiveOverview) -> String {
    let Some(objective) = &view.objective else {
        return "Objective\n".into();
    };
    let id = &objective.objective_id;
    let status = objective.status();
    let closed = matches!(
        status,
        ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
    );
    let mut lines = vec![
        format!("Objective {id}: {}", status_words(status)),
        // The outcome is one operator-written field: a line break in it must not add a line.
        format!("Outcome: {}", terminal_text(objective.outcome.trim())),
    ];
    if let Some(summary) = objective
        .completion_summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
    {
        let label = if status == ObjectiveStatus::ReadyForReview {
            "Owner's assessment"
        } else {
            "Result"
        };
        lines.push(format!("{label}: {}", block(summary, "  ")));
    }
    lines.push(format!("Owner: {}", objective.owner_tag_id));
    if let Some(team) = &view.team {
        let members = if team.member_tag_ids.is_empty() {
            "no members".to_owned()
        } else {
            team.member_tag_ids.join(", ")
        };
        lines.push(format!("Team: {} ({members})", team.name));
    }
    lines.push(budget_line(view));
    if let Some(deadline) = &view.deadline {
        lines.push(format!(
            "Deadline: {} ({})",
            time(deadline.at_ms),
            deadline.remaining
        ));
    }

    lines.push(String::new());
    lines.push("Delivered:".into());
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
    match (&objective.completion_summary, status) {
        (Some(summary), ObjectiveStatus::Completed) if !summary.trim().is_empty() => {
            lines.push(format!("  {}", first_line(summary)))
        }
        _ if !delivered.is_empty() => {}
        _ if closed => lines.push("  Nothing was delivered.".into()),
        _ => lines.push("  Nothing yet.".into()),
    }
    for (session, delivery) in delivered {
        lines.extend(delivery_lines(session, delivery));
    }

    lines.push(String::new());
    lines.push("Needs you:".into());
    let needs: Vec<_> = view
        .attention
        .iter()
        .filter(|item| item.kind() != ObjectiveAttentionKind::Cancelled)
        .collect();
    if needs.is_empty() {
        lines.push("  Nothing right now.".into());
    }
    for item in needs {
        // A question appears in full: the operator has no other way to read it.
        lines.push(format!("  {}", block(&item.message, "    ")));
        for action in &item.next_actions {
            lines.push(format!("    {action}"));
        }
    }

    lines.push(String::new());
    lines.push(format!(
        "Work: {}",
        plural(u64::from(view.total_sessions), "Session")
    ));
    let status_width = view
        .sessions
        .iter()
        .map(|session| session_words(session.status()).len())
        .max()
        .unwrap_or(0);
    let tag_width = view
        .sessions
        .iter()
        .map(|session| session.tag_id.len())
        .max()
        .unwrap_or(0);
    for session in &view.sessions {
        let label = session_label(session);
        let latest = if session.latest_task_id.is_empty() {
            String::new()
        } else {
            format!(
                "  ({}, latest Task {})",
                plural(u64::from(session.task_count), "Task"),
                session.latest_task_id
            )
        };
        lines.push(format!(
            "  {:status_width$}  {:tag_width$}  {label}{latest}",
            session_words(session.status()),
            session.tag_id
        ));
    }
    // A failed or uncertain latest turn explains itself under its Session.
    for session in &view.sessions {
        if let Some(failure) = &session.failure {
            lines.extend(failure_lines(session, failure));
        }
    }
    if view.total_sessions as usize > view.sessions.len() {
        lines.push(format!(
            "  … {} more",
            view.total_sessions as usize - view.sessions.len()
        ));
    }

    if !view.conversation.is_empty() {
        lines.push(String::new());
        lines.push("Objective conversation:".into());
        for turn in &view.conversation {
            lines.push(format!(
                "  {} ({}, {}): {}",
                turn.task_id,
                turn_from(turn, &objective.owner_tag_id),
                task_words(turn.state()),
                first_line(&turn.prompt)
            ));
            if !turn.result.trim().is_empty() {
                lines.push(format!(
                    "    {} replied: {}",
                    objective.owner_tag_id,
                    first_line(&turn.result)
                ));
            }
        }
    }

    if !view.posts.is_empty() {
        lines.push(String::new());
        lines.push("Team posts:".into());
        for post in &view.posts {
            let to = if post.to_tag_ids.is_empty() {
                String::new()
            } else {
                format!(" to {}", post.to_tag_ids.join(", "))
            };
            lines.push(format!(
                "  #{} {}{to}: {}",
                post.sequence,
                post.author_tag_id,
                first_line(&post.body)
            ));
        }
    }

    lines.push(String::new());
    lines.push("Details:".into());
    lines.push(format!("  Revision: {}", objective.revision));
    if objective.ongoing {
        lines.push("  Ongoing: only an operator ends it".into());
    }
    if let Some(paused) = objective.paused_at_ms {
        lines.push(format!("  Paused: {}", time(paused)));
    }
    if status == ObjectiveStatus::Cancelled {
        lines.push(format!(
            "  Cancelled: {}",
            objective
                .cancelled_at_ms
                .map_or_else(|| "time not recorded".into(), time)
        ));
        if let Some(reason) = &objective.cancellation_reason {
            lines.push(format!("  Reason: {}", block(reason, "    ")));
        }
    }
    for notice in &view.notices {
        lines.push(format!(
            "  {}: {}",
            time(notice.at_ms),
            block(&notice.message, "    ")
        ));
    }
    if let Some(team) = &view.team {
        lines.push(match team.max_concurrency {
            Some(limit) => format!(
                "  Team {}: at most {limit} turns at once across its Objectives; {} running now",
                team.name, team.running_turns
            ),
            None => format!(
                "  Team {}: turns limited only by Worker Host capacity; {} running now",
                team.name, team.running_turns
            ),
        });
    }
    if view.total_tasks > 0 {
        lines.push(format!(
            "  Tasks: {}",
            plural(u64::from(view.total_tasks), "Task")
        ));
    }
    if !closed {
        lines.push(format!("  Follow it: supertag watch objective {id}"));
    }
    lines.push(format!(
        "  Full record: supertag describe objective {id} --output json"
    ));
    // Every line is free of terminal controls; tabs and newlines inside
    // recorded text were split or replaced above.
    let mut out = lines
        .iter()
        .map(|line| {
            line.split('\n')
                .map(terminal_text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

/// How a Session is named in text: the Objective's conversation, its title, or its ID.
pub(crate) fn session_label(session: &ObjectiveSessionView) -> String {
    if session.owner {
        "Objective conversation".to_owned()
    } else if session.title.is_empty() {
        format!("Session {}", session.session_id)
    } else {
        first_line(&session.title)
    }
}

fn short_commit(commit: &str) -> &str {
    commit.get(..12).unwrap_or(commit)
}

/// A Session's latest delivery: what it changed, where, and how to fetch it.
pub(crate) fn delivery_summary(delivery: &ObjectiveSessionDelivery) -> String {
    let files = plural(delivery.changed_files, "changed file");
    if delivery.committed {
        format!(
            "Commit {} in Workspace {}, {files} since {}",
            short_commit(&delivery.head_commit),
            delivery.workspace_id,
            short_commit(&delivery.base_commit)
        )
    } else {
        format!(
            "Uncommitted changes in Workspace {}, {files}",
            delivery.workspace_id
        )
    }
}

fn delivery_lines(
    session: &ObjectiveSessionView,
    delivery: &ObjectiveSessionDelivery,
) -> Vec<String> {
    let mut lines = vec![
        format!(
            "  {} ({}, Task {})",
            session_label(session),
            session.tag_id,
            delivery.task_id
        ),
        format!("    {}", delivery_summary(delivery)),
    ];
    if delivery.patch {
        lines.push(format!(
            "    Download: supertag task download {} --kind patch --output FILE",
            delivery.task_id
        ));
    }
    lines
}

fn failure_lines(session: &ObjectiveSessionView, failure: &ObjectiveSessionFailure) -> Vec<String> {
    let mut lines = vec![format!(
        "    {}: Task {} {}{}",
        session_label(session),
        failure.task_id,
        task_words(failure.state()),
        match failure.harness_kind() {
            HarnessKind::Unspecified => String::new(),
            kind => format!(" on {}", words(kind.as_str_name(), "HARNESS_KIND_")),
        }
    )];
    if !failure.message.trim().is_empty() {
        lines.push(format!("      {}", block(&failure.message, "      ")));
    }
    for action in &failure.next_actions {
        lines.push(format!("      {action}"));
    }
    lines
}

fn turn_json(turn: &ObjectiveTurn) -> Value {
    json!({
        "task_id": turn.task_id,
        "tag_id": turn.tag_id,
        "session_id": turn.session_id,
        "state": turn.state().as_str_name(),
        "kind": turn.kind,
        "prompt": turn.prompt,
        "result": turn.result,
        "completed_at_ms": turn.completed_at_ms,
    })
}

/// The full overview record for `--output json`.
pub(crate) fn json(view: &ObjectiveOverview) -> Value {
    json!({
        "objective": view.objective.clone().map(crate::objectives::output),
        "as_of_ms": view.as_of_ms,
        "team": view.team.as_ref().map(|team| json!({
            "team_id": team.team_id,
            "name": team.name,
            "member_tag_ids": team.member_tag_ids,
            "max_concurrency": team.max_concurrency,
            "running_turns": team.running_turns,
        })),
        "pool": view.pool.as_ref().map(|pool| json!({
            "measure": pool.measure().as_str_name(),
            "currency": pool.currency,
            "limit_minor": pool.limit_minor,
            "spent_minor": pool.spent_minor,
            "available_minor": pool.available_minor,
            "overrun_minor": pool.overrun_minor,
            "exhausted": pool.exhausted,
            "unknown_cost_attempts": pool.unknown_cost_attempts,
            "estimated_cost_attempts": pool.estimated_cost_attempts,
        })),
        "deadline": view.deadline.as_ref().map(|deadline| json!({
            "at_ms": deadline.at_ms,
            "passed": deadline.passed,
            "grace_ends_at_ms": deadline.grace_ends_at_ms,
            "remaining": deadline.remaining,
        })),
        "attention": view.attention.iter().map(|item| json!({
            "kind": item.kind().as_str_name(),
            "message": item.message,
            "next_actions": item.next_actions,
            "task_id": item.task_id,
            "tag_id": item.tag_id,
        })).collect::<Vec<_>>(),
        "sessions": view.sessions.iter().map(|session| json!({
            "session_id": session.session_id,
            "tag_id": session.tag_id,
            "owner": session.owner,
            "title": session.title,
            "parent_session_id": session.parent_session_id,
            "status": session.status().as_str_name(),
            "question": session.question,
            "task_count": session.task_count,
            "latest_task_id": session.latest_task_id,
            "latest_completed_at_ms": session.latest_completed_at_ms,
            "delivery": session.delivery.as_ref().map(|delivery| json!({
                "task_id": delivery.task_id,
                "workspace_id": delivery.workspace_id,
                "base_commit": delivery.base_commit,
                "head_commit": delivery.head_commit,
                "committed": delivery.committed,
                "changed_files": delivery.changed_files,
                "patch": delivery.patch,
            })),
            "failure": session.failure.as_ref().map(|failure| json!({
                "task_id": failure.task_id,
                "state": failure.state().as_str_name(),
                "harness_kind": failure.harness_kind().as_str_name(),
                "message": failure.message,
                "next_actions": failure.next_actions,
            })),
        })).collect::<Vec<_>>(),
        "total_sessions": view.total_sessions,
        "conversation": view.conversation.iter().map(turn_json).collect::<Vec<_>>(),
        "posts": view.posts.iter().map(|post| json!({
            "sequence": post.sequence,
            "author_tag_id": post.author_tag_id,
            "to_tag_ids": post.to_tag_ids,
            "body": post.body,
            "created_at_ms": post.created_at_ms,
        })).collect::<Vec<_>>(),
        "tasks": view.tasks.iter().map(turn_json).collect::<Vec<_>>(),
        "total_tasks": view.total_tasks,
        "next_offset": view.next_offset,
        "notices": view.notices.iter().map(|notice| json!({
            "key": notice.key,
            "kind": notice.kind,
            "at_ms": notice.at_ms,
            "message": notice.message,
        })).collect::<Vec<_>>(),
        "pending_approvals": view.pending_approvals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{
        Objective, ObjectiveAttention, ObjectiveBudgetPool, ObjectiveOverviewTeam,
        ObjectiveSessionView,
    };

    fn view(status: ObjectiveStatus) -> ObjectiveOverview {
        ObjectiveOverview {
            objective: Some(Objective {
                objective_id: "ship-sso".into(),
                owner_tag_id: "planner".into(),
                outcome: "Ship SSO for the admin console".into(),
                status: status as i32,
                revision: 4,
                ..Default::default()
            }),
            pool: Some(ObjectiveBudgetPool {
                measure: ObjectiveBudgetMeasure::Unlimited as i32,
                ..Default::default()
            }),
            sessions: vec![ObjectiveSessionView {
                session_id: "s1".into(),
                tag_id: "planner".into(),
                owner: true,
                status: ObjectiveSessionStatus::Running as i32,
                task_count: 1,
                latest_task_id: "t1".into(),
                ..Default::default()
            }],
            total_sessions: 1,
            ..Default::default()
        }
    }

    #[test]
    fn leads_with_status_outcome_and_what_needs_the_operator() {
        let mut ready = view(ObjectiveStatus::ReadyForReview);
        ready.objective.as_mut().unwrap().completion_summary =
            Some("Shipped behind a flag.".into());
        ready.attention.push(ObjectiveAttention {
            kind: ObjectiveAttentionKind::Review as i32,
            message: "The owner submitted the Objective for review.".into(),
            next_actions: vec!["supertag objective review ship-sso approve".into()],
            ..Default::default()
        });
        let text = text(&ready);
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "Objective ship-sso: ready for review");
        assert_eq!(lines[1], "Outcome: Ship SSO for the admin console");
        assert_eq!(lines[2], "Owner's assessment: Shipped behind a flag.");
        assert!(text.contains(
            "Needs you:\n  The owner submitted the Objective for review.\n    supertag objective review ship-sso approve\n"
        ));
        assert!(text.contains("Work: 1 Session\n"));
        assert!(text.contains("Follow it: supertag watch objective"));
    }

    #[test]
    fn a_closed_objective_says_nothing_was_delivered_and_keeps_the_record_command() {
        let mut cancelled = view(ObjectiveStatus::Cancelled);
        cancelled.objective.as_mut().unwrap().cancelled_at_ms = Some(1_794_009_720_000);
        let text = text(&cancelled);
        assert!(
            text.contains("Delivered:\n  Nothing was delivered."),
            "{text}"
        );
        assert!(text.contains("Needs you:\n  Nothing right now."), "{text}");
        assert!(text.contains("Cancelled: 2026-11-07T00:02:00"), "{text}");
        assert!(text.contains("Full record: supertag describe objective ship-sso --output json"));
        assert!(!text.contains("Follow it"));
    }

    #[test]
    fn budgets_and_team_limits_read_in_plain_words() {
        let mut budgeted = view(ObjectiveStatus::Working);
        budgeted.pool = Some(ObjectiveBudgetPool {
            measure: ObjectiveBudgetMeasure::ProviderReportedCost as i32,
            currency: Some("USD".into()),
            limit_minor: Some(1000),
            spent_minor: Some(250),
            available_minor: Some(750),
            unknown_cost_attempts: 1,
            ..Default::default()
        });
        budgeted.team = Some(ObjectiveOverviewTeam {
            team_id: "t".into(),
            name: "delivery".into(),
            member_tag_ids: vec!["helper".into(), "planner".into()],
            max_concurrency: Some(2),
            running_turns: 1,
        });
        let text = text(&budgeted);
        assert!(
            text.contains("Budget: $2.50 of $10.00 spent; 1 Task Attempt with unknown cost"),
            "{text}"
        );
        assert!(text.contains("Team: delivery (helper, planner)"));
        assert!(text.contains("at most 2 turns at once across its Objectives; 1 running now"));
        budgeted.team.as_mut().unwrap().max_concurrency = None;
        assert!(super::text(&budgeted).contains("turns limited only by Worker Host capacity"));
    }

    #[test]
    fn names_each_delivery_and_explains_a_failed_turn() {
        let mut working = view(ObjectiveStatus::Working);
        working.sessions.push(ObjectiveSessionView {
            session_id: "s2".into(),
            tag_id: "builder".into(),
            title: "Build the exporter".into(),
            status: ObjectiveSessionStatus::Succeeded as i32,
            task_count: 1,
            latest_task_id: "t2".into(),
            delivery: Some(ObjectiveSessionDelivery {
                task_id: "t2".into(),
                workspace_id: "product".into(),
                base_commit: "fedcba9876543210".into(),
                head_commit: "0123456789abcdef".into(),
                committed: true,
                changed_files: 3,
                patch: true,
            }),
            ..Default::default()
        });
        working.sessions[0].status = ObjectiveSessionStatus::Failed as i32;
        working.sessions[0].failure = Some(ObjectiveSessionFailure {
            task_id: "t1".into(),
            state: TaskState::Failed as i32,
            harness_kind: HarnessKind::Codex as i32,
            message: "The harness is not signed in.\u{1b}[2J".into(),
            next_actions: vec!["supertag task events t1".into()],
        });
        working.total_sessions = 2;
        let text = text(&working);
        assert!(
            text.contains(
                "Delivered:\n  Build the exporter (builder, Task t2)\n    Commit 0123456789ab in Workspace product, 3 changed files since fedcba987654\n    Download: supertag task download t2 --kind patch --output FILE\n"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "    Objective conversation: Task t1 failed on codex\n      The harness is not signed in. [2J\n      supertag task events t1\n"
            ),
            "{text}"
        );
        assert!(
            text.contains("Follow it: supertag watch objective ship-sso"),
            "{text}"
        );
        let json = json(&working);
        assert_eq!(json["sessions"][1]["delivery"]["changed_files"], 3);
        assert_eq!(json["sessions"][1]["delivery"]["patch"], true);
        assert_eq!(json["sessions"][0]["failure"]["state"], "TASK_STATE_FAILED");
        assert_eq!(
            json["sessions"][0]["failure"]["next_actions"][0],
            "supertag task events t1"
        );
        // An uncommitted delivery names its Workspace without a commit.
        let mut uncommitted = working.sessions[1].delivery.clone().unwrap();
        uncommitted.committed = false;
        uncommitted.changed_files = 1;
        assert_eq!(
            delivery_summary(&uncommitted),
            "Uncommitted changes in Workspace product, 1 changed file"
        );
    }

    #[test]
    fn agent_text_cannot_drive_the_terminal() {
        let mut asked = view(ObjectiveStatus::Working);
        asked.attention.push(ObjectiveAttention {
            kind: ObjectiveAttentionKind::Question as i32,
            message: "planner asks: \"Pick one:\u{1b}[2K\r rm -rf /\nSecond line\"".into(),
            next_actions: vec!["supertag question answer t1 TEXT".into()],
            ..Default::default()
        });
        let text = text(&asked);
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\r'));
        assert!(text.contains("planner asks: \"Pick one:"));
        assert!(text.contains("\n    Second line\""));
    }
}
