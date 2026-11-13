//! Operator observation commands: `spend`, `metrics`, and `watch`, and the readable text
//! `describe` prints.
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, ValueEnum};
use serde_json::{Value, json};
use supertag_control_plane::objective_limits::Timestamp;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        GetMetricsRequest, GetSpendRequest, HostPhase, MetricSnapshot, SpendGrouping, SpendReport,
        WatchEvent, WatchKind, WatchRequest, metrics_client::MetricsClient,
        operator_events_client::OperatorEventsClient, spend_client::SpendClient,
        watch_event::Update,
    },
};
use tonic::Code;

use crate::{Connection, connect_operator, request, resolve_target};

#[derive(Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum Output {
    #[default]
    Text,
    Json,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum SpendBy {
    Objective,
    Tag,
    Day,
}

#[derive(Args)]
pub struct SpendArgs {
    /// Group Attempts by Objective (default), Tag, or UTC day claimed.
    #[arg(long, value_enum, default_value = "objective")]
    by: SpendBy,
    /// Only Attempts claimed at or after this RFC 3339 time.
    #[arg(long)]
    since: Option<String>,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

pub async fn spend(connection: Connection, args: SpendArgs) -> Result<()> {
    let since_ms = args
        .since
        .as_deref()
        .map(|value| {
            Timestamp::parse(value)
                .map(Timestamp::as_millis)
                .context("--since must be an RFC 3339 time with a time zone")
        })
        .transpose()?;
    let by = match args.by {
        SpendBy::Objective => SpendGrouping::Objective,
        SpendBy::Tag => SpendGrouping::Tag,
        SpendBy::Day => SpendGrouping::Day,
    };
    let (channel, token) = connect_operator(connection).await?;
    let report = SpendClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
        .get_spend(request(
            GetSpendRequest {
                by: by as i32,
                since_ms,
            },
            &token,
        )?)
        .await?
        .into_inner();
    match args.output {
        Output::Json => crate::terminal::print_json(&spend_json(&report))?,
        Output::Text => out!("{}", spend_text(&report)),
    }
    Ok(())
}

#[derive(Args)]
pub struct MetricsArgs {
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

pub async fn metrics(connection: Connection, args: MetricsArgs) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let snapshot = MetricsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
        .get_metrics(request(GetMetricsRequest {}, &token)?)
        .await?
        .into_inner();
    match args.output {
        Output::Json => crate::terminal::print_json(&metrics_json(&snapshot))?,
        Output::Text => out!("{}", metrics_text(&snapshot)),
    }
    Ok(())
}

fn metrics_json(snapshot: &MetricSnapshot) -> Value {
    let resources = snapshot.resources.unwrap_or_default();
    let tasks = snapshot.tasks.unwrap_or_default();
    let usage = snapshot.usage.clone().unwrap_or_default();
    let scheduling = snapshot.scheduling.clone().unwrap_or_default();
    let mailbox = snapshot.mailbox.unwrap_or_default();
    let replies = snapshot.reply_delivery.unwrap_or_default();
    let recovery = snapshot.recovery.unwrap_or_default();
    json!({
        "captured_at": Timestamp::from_millis(snapshot.captured_at_ms).map(|at| at.to_string()),
        "tags": resources.tags,
        "roles": resources.roles,
        "role_assignments": resources.role_assignments,
        "surface_accounts": resources.surface_accounts,
        "permission_sets": resources.permission_sets,
        "context_sets": resources.context_sets,
        "sessions": resources.sessions,
        "tasks": {
            "total": tasks.total,
            "queued": tasks.queued,
            "claimed": tasks.claimed,
            "running": tasks.running,
            "uncertain": tasks.uncertain,
            "succeeded": tasks.succeeded,
            "failed": tasks.failed,
            "cancelled": tasks.cancelled,
        },
        "usage": {
            "attempts": usage.attempts,
            "reported_tokens": usage.reported_tokens,
            "unknown_token_attempts": usage.unknown_token_attempts,
            "reported_cost": usage.reported_cost.iter().map(|amount| json!({
                "currency": amount.currency,
                "amount_minor": amount.amount_minor,
            })).collect::<Vec<_>>(),
            "unknown_cost_attempts": usage.unknown_cost_attempts,
            "estimated_cost_attempts": usage.estimated_cost_attempts,
        },
        "recovery": {
            "awaiting_decision": recovery.awaiting_decision,
            "cleanup_unconfirmed": recovery.cleanup_unconfirmed,
            "resolved_failed": recovery.resolved_failed,
            "resolved_retried": recovery.resolved_retried,
        },
        "scheduling": {
            "queued": scheduling.queued,
            "oldest_queued_at": scheduling
                .oldest_queued_at_ms
                .and_then(Timestamp::from_millis)
                .map(|at| at.to_string()),
            "placed_tasks": scheduling.placed_tasks,
            "average_queue_wait_ms": scheduling.average_queue_wait_ms,
            "maximum_queue_wait_ms": scheduling.maximum_queue_wait_ms,
            "started_attempts": scheduling.started_attempts,
            "average_start_wait_ms": scheduling.average_start_wait_ms,
            "maximum_start_wait_ms": scheduling.maximum_start_wait_ms,
            "worker_hosts": scheduling.worker_hosts.iter().map(|host| json!({
                "id": host.host_id,
                "phase": host_phase(host.phase()),
                "draining": host.draining,
                "capacity": host.capacity,
                "available_slots": host.available_slots,
                "active_attempts": host.active_attempts,
            })).collect::<Vec<_>>(),
        },
        "mailbox": {
            "pending": mailbox.pending,
            "oldest_pending_at": mailbox
                .oldest_pending_at_ms
                .and_then(Timestamp::from_millis)
                .map(|at| at.to_string()),
        },
        "reply_delivery": {
            "backlog": replies.backlog,
            "failed": replies.failed,
        },
    })
}

fn host_phase(phase: HostPhase) -> &'static str {
    match phase {
        HostPhase::Unspecified => "unknown",
        other => other
            .as_str_name()
            .strip_prefix("HOST_PHASE_")
            .unwrap_or("unknown"),
    }
}

/// A duration in milliseconds, in the largest unit that keeps it readable.
fn wait(ms: i64) -> String {
    match ms {
        ms if ms < 1_000 => format!("{ms}ms"),
        ms if ms < 60_000 => format!("{:.1}s", ms as f64 / 1_000.0),
        ms => format!("{}m {}s", ms / 60_000, ms % 60_000 / 1_000),
    }
}

fn metrics_text(snapshot: &MetricSnapshot) -> String {
    let resources = snapshot.resources.unwrap_or_default();
    let tasks = snapshot.tasks.unwrap_or_default();
    let usage = snapshot.usage.clone().unwrap_or_default();
    let scheduling = snapshot.scheduling.clone().unwrap_or_default();
    let mailbox = snapshot.mailbox.unwrap_or_default();
    let replies = snapshot.reply_delivery.unwrap_or_default();
    let recovery = snapshot.recovery.unwrap_or_default();
    let cost = usage
        .reported_cost
        .iter()
        .map(|amount| format!("{} {}", amount.amount_minor, amount.currency))
        .collect::<Vec<_>>();
    format!(
        "Tags {}, Sessions {}, Roles {}, Role assignments {}, Surface Accounts {}, Permission Sets {}, Context Sets {}\n\
         Tasks {}: {} queued, {} claimed, {} running, {} uncertain, {} succeeded, {} failed, {} cancelled\n\
         Attempts {}: tokens {}, cost {}\n\
         Worker Hosts {}: {} active of {} slots\n\
         Queue: {} placed, waited {} on average and {} at most before a claim; started {} on average and {} at most after it{}\n\
         Recovery: {} Attempts await a decision, {} cancelled Attempts await cleanup; {} resolved as failed, {} retried\n\
         Mailbox backlog {}, reply backlog {}, failed replies {}\n",
        resources.tags,
        resources.sessions,
        resources.roles,
        resources.role_assignments,
        resources.surface_accounts,
        resources.permission_sets,
        resources.context_sets,
        tasks.total,
        tasks.queued,
        tasks.claimed,
        tasks.running,
        tasks.uncertain,
        tasks.succeeded,
        tasks.failed,
        tasks.cancelled,
        usage.attempts,
        usage
            .reported_tokens
            .map_or_else(|| "unknown".into(), |tokens| tokens.to_string()),
        if cost.is_empty() {
            "none reported".into()
        } else {
            cost.join(", ")
        },
        scheduling.worker_hosts.len(),
        scheduling
            .worker_hosts
            .iter()
            .map(|host| u64::from(host.active_attempts))
            .sum::<u64>(),
        scheduling
            .worker_hosts
            .iter()
            .map(|host| u64::from(host.capacity))
            .sum::<u64>(),
        scheduling.placed_tasks,
        wait(scheduling.average_queue_wait_ms),
        wait(scheduling.maximum_queue_wait_ms),
        wait(scheduling.average_start_wait_ms),
        wait(scheduling.maximum_start_wait_ms),
        scheduling
            .oldest_queued_at_ms
            .and_then(Timestamp::from_millis)
            .map_or_else(String::new, |at| format!(
                "; oldest queued Task accepted {at}"
            )),
        recovery.awaiting_decision,
        recovery.cleanup_unconfirmed,
        recovery.resolved_failed,
        recovery.resolved_retried,
        mailbox.pending,
        replies.backlog,
        replies.failed,
    )
}

fn spend_json(report: &SpendReport) -> Value {
    json!({
        "by": match report.by() {
            SpendGrouping::Tag => "tag",
            SpendGrouping::Day => "day",
            _ => "objective",
        },
        "since": report.since_ms.and_then(Timestamp::from_millis).map(|at| at.to_string()),
        "groups": report.groups.iter().map(|group| json!({
            "key": group.key,
            "name": (!group.name.is_empty()).then_some(&group.name),
            "attempts": group.attempts,
            "reported_cost_by_currency": (!group.reported_cost.is_empty()).then(|| group
                .reported_cost
                .iter()
                .map(|cost| (cost.currency.clone(), json!(cost.amount_minor)))
                .collect::<serde_json::Map<_, _>>()),
            "unknown_cost_attempts": group.unknown_cost_attempts,
            "estimated_cost_attempts": group.estimated_cost_attempts,
            "unpriced_models": group
                .unpriced_models
                .iter()
                .map(|model| (model.model.clone(), json!(model.attempts)))
                .collect::<serde_json::Map<_, _>>(),
            "unpriced_tokens": group.unpriced_tokens,
            "reported_tokens": group.reported_tokens,
            "unknown_token_attempts": group.unknown_token_attempts,
            "budget": group.budget.as_ref().map(|budget| json!({
                "limit_minor": budget.limit_minor,
                "currency": budget.currency,
            })),
        })).collect::<Vec<_>>(),
    })
}

/// Matches the TypeScript `formatSpend` line shape (apps/cli/src/spend.ts).
fn spend_text(report: &SpendReport) -> String {
    if report.groups.is_empty() {
        return "No Task Attempts.\n".into();
    }
    let objective = report.by() == SpendGrouping::Objective;
    let mut out = String::new();
    for group in &report.groups {
        let label = if group.name.is_empty() {
            &group.key
        } else {
            &group.name
        };
        let cost = if !group.reported_cost.is_empty() {
            group
                .reported_cost
                .iter()
                .map(|cost| money(cost.amount_minor, &cost.currency))
                .collect::<Vec<_>>()
                .join(", ")
        } else if group.unpriced_models.is_empty() {
            "unknown".into()
        } else {
            "unpriced".into()
        };
        let mut line = format!(
            "{} | {} Attempt(s) | cost {cost}",
            crate::terminal::text(label),
            group.attempts
        );
        if group.estimated_cost_attempts > 0 {
            line += &format!(
                "; {} estimated-cost Attempt(s)",
                group.estimated_cost_attempts
            );
        }
        if group.unknown_cost_attempts > 0 {
            let mut reasons = group
                .unpriced_models
                .iter()
                .map(|model| {
                    format!(
                        "unpriced: no reported or estimated cost for {} in {}; tokens recorded",
                        crate::terminal::text(&model.model),
                        model.attempts
                    )
                })
                .collect::<Vec<_>>();
            let priced: u64 = group.unpriced_models.iter().map(|m| m.attempts).sum();
            if group.unknown_cost_attempts > priced {
                reasons.push(format!(
                    "no cost reported in {}",
                    group.unknown_cost_attempts - priced
                ));
            }
            line += &format!(
                "; {} unknown-cost Attempt(s): {}",
                group.unknown_cost_attempts,
                reasons.join("; ")
            );
        }
        match group.reported_tokens {
            Some(tokens) => line += &format!(" | tokens {tokens}"),
            None => line += " | tokens unknown",
        }
        if group.unknown_token_attempts > 0 {
            line += &format!(
                "; {} unknown-token Attempt(s)",
                group.unknown_token_attempts
            );
        }
        if objective {
            line += &match &group.budget {
                Some(budget) => match &budget.currency {
                    Some(currency) => format!(" | budget {}", money(budget.limit_minor, currency)),
                    None => format!(" | budget {} allocation units", budget.limit_minor),
                },
                None => " | budget none".into(),
            };
        }
        out += &line;
        out.push('\n');
    }
    out
}

/// Minor units as currency, such as 1234 USD as $12.34.
pub(crate) fn money(minor: u64, currency: &str) -> String {
    let (symbol, digits) = match currency {
        "USD" => ("$", 2),
        "EUR" => ("€", 2),
        "GBP" => ("£", 2),
        "JPY" => ("¥", 0),
        "KRW" => ("₩", 0),
        _ if currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_uppercase()) => ("", 2),
        _ => return format!("{minor} {} minor units", crate::terminal::text(currency)),
    };
    let amount = if digits == 0 {
        group_thousands(minor)
    } else {
        format!("{}.{:02}", group_thousands(minor / 100), minor % 100)
    };
    if symbol.is_empty() {
        format!("{currency} {amount}")
    } else {
        format!("{symbol}{amount}")
    }
}

fn group_thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

macro_rules! client {
    ($client:ident, $channel:expr) => {
        $client::new($channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    };
}

/// Readable text for a resource: one `Field: value` line per field in name
/// order, nested values indented, empty values omitted, and `*_ms` times
/// shown as RFC 3339.
pub(crate) fn describe_text(title: &str, value: &Value) -> String {
    let mut out = format!("{title}\n");
    if let Value::Object(fields) = value {
        for (key, value) in fields {
            render(&mut out, 1, key, value);
        }
    }
    out
}

fn label(key: &str) -> String {
    let key = key.strip_suffix("_ms").unwrap_or(key);
    let mut words = key.split('_').filter(|w| !w.is_empty());
    let mut out = String::new();
    if let Some(first) = words.next() {
        let mut chars = first.chars();
        if let Some(c) = chars.next() {
            out.extend(c.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    for word in words {
        out.push(' ');
        out.push_str(match word {
            "id" => "ID",
            "ids" => "IDs",
            other => other,
        });
    }
    out
}

fn empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(fields) => fields.values().all(empty),
        _ => false,
    }
}

fn render(out: &mut String, depth: usize, key: &str, value: &Value) {
    if empty(value) {
        return;
    }
    let indent = "  ".repeat(depth - 1);
    let name = label(key);
    match value {
        Value::Object(fields) => {
            out.push_str(&format!("{indent}{name}:\n"));
            for (key, value) in fields {
                render(out, depth + 1, key, value);
            }
        }
        Value::Array(items) if items.iter().all(|item| !item.is_object()) => {
            let items = items.iter().map(scalar).collect::<Vec<_>>().join(", ");
            out.push_str(&format!("{indent}{name}: {items}\n"));
        }
        Value::Array(items) => {
            out.push_str(&format!("{indent}{name}:\n"));
            for item in items {
                if let Value::Object(fields) = item {
                    let mut first = true;
                    for (key, value) in fields {
                        if empty(value) {
                            continue;
                        }
                        let mut line = String::new();
                        render(&mut line, depth + 1, key, value);
                        if first {
                            // Mark the start of each item.
                            let cut = "  ".repeat(depth).len();
                            line.replace_range(cut - 2..cut, "- ");
                            first = false;
                        }
                        out.push_str(&line);
                    }
                } else {
                    out.push_str(&format!("{indent}  - {}\n", scalar(item)));
                }
            }
        }
        _ if key.ends_with("_ms") && value.as_i64().is_some() => {
            let shown = value
                .as_i64()
                .and_then(Timestamp::from_millis)
                .map(|at| at.to_string())
                .unwrap_or_else(|| value.to_string());
            out.push_str(&format!("{indent}{name}: {shown}\n"));
        }
        _ => out.push_str(&format!("{indent}{name}: {}\n", scalar(value))),
    }
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => crate::terminal::text(text),
        other => other.to_string(),
    }
}

/// A kind of change `watch` follows: a resource kind marked `watch` in
/// [`crate::resources::KINDS`], or one of [`WATCH_EVENT_STREAMS`].
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum WatchKindArg {
    #[value(alias = "tags")]
    Tag,
    #[value(alias = "tasks")]
    Task,
    #[value(alias = "conversation-messages")]
    ConversationMessage,
    #[value(alias = "objectives")]
    Objective,
    #[value(alias = "teams")]
    Team,
    #[value(alias = "workstream-posts")]
    WorkstreamPost,
}

/// Change streams `watch` follows that are not resources `get` reads: messages in a Session's
/// conversation. Singular, then plural.
#[cfg(test)]
pub(crate) const WATCH_EVENT_STREAMS: &[[&str; 2]] =
    &[["conversation-message", "conversation-messages"]];

impl From<WatchKindArg> for WatchKind {
    fn from(value: WatchKindArg) -> Self {
        match value {
            WatchKindArg::Tag => WatchKind::Tag,
            WatchKindArg::Task => WatchKind::Task,
            WatchKindArg::ConversationMessage => WatchKind::ConversationMessage,
            WatchKindArg::Objective => WatchKind::Objective,
            WatchKindArg::Team => WatchKind::Team,
            WatchKindArg::WorkstreamPost => WatchKind::WorkstreamPost,
        }
    }
}

/// A `watch` argument: a kind of change, or the ID that follows `objective`.
#[derive(Clone)]
pub enum WatchTarget {
    Kind(WatchKindArg),
    Id(String),
}

/// Parses kinds as their value enum does, keeps anything else as an ID, and offers the kinds as
/// the argument's possible values.
#[derive(Clone)]
struct WatchTargetParser;

impl clap::builder::TypedValueParser for WatchTargetParser {
    type Value = WatchTarget;

    fn parse_ref(
        &self,
        command: &clap::Command,
        _argument: Option<&clap::Arg>,
        value: &std::ffi::OsStr,
    ) -> std::result::Result<WatchTarget, clap::Error> {
        let text = value.to_str().ok_or_else(|| {
            clap::Error::new(clap::error::ErrorKind::InvalidUtf8).with_cmd(command)
        })?;
        Ok(match WatchKindArg::from_str(text, true) {
            Ok(kind) => WatchTarget::Kind(kind),
            Err(_) => WatchTarget::Id(text.to_owned()),
        })
    }

    fn possible_values(
        &self,
    ) -> Option<Box<dyn Iterator<Item = clap::builder::PossibleValue> + '_>> {
        Some(Box::new(
            WatchKindArg::value_variants()
                .iter()
                .filter_map(ValueEnum::to_possible_value),
        ))
    }
}

#[derive(Args)]
pub struct WatchArgs {
    /// Only these kinds of change; omit for every kind. `watch objective ID` follows one
    /// Objective's progress as a timeline until it closes.
    #[arg(value_name = "KIND", value_parser = WatchTargetParser)]
    kinds: Vec<WatchTarget>,
    /// With `watch objective ID`: seconds to wait after the Objective closes for its running
    /// Sessions to record their turns.
    #[arg(long, default_value_t = 10)]
    settle_seconds: u64,
    /// Continue after the last notice a previous watch printed.
    #[arg(long)]
    resume_token: Option<String>,
    /// Stop after this many change notices.
    #[arg(long)]
    limit: Option<u64>,
    /// Seconds to keep reconnecting with the last resume token after the
    /// connection drops. Zero exits on the first disconnect.
    #[arg(long, default_value_t = 60)]
    reconnect_seconds: u64,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

/// Streams change notices. A dropped connection is resumed from the last
/// resume token, so no notice is missed or repeated across reconnects; a
/// resync notice means the feed moved past the token and state must be reread.
pub async fn watch(connection: Connection, args: WatchArgs) -> Result<()> {
    if let [
        WatchTarget::Kind(WatchKindArg::Objective),
        WatchTarget::Id(id),
    ] = args.kinds.as_slice()
    {
        return crate::objective_watch::watch(
            connection,
            id.clone(),
            args.output,
            Duration::from_secs(args.settle_seconds),
        )
        .await;
    }
    let kinds = args
        .kinds
        .iter()
        .map(|target| match target {
            WatchTarget::Kind(kind) => Ok(WatchKind::from(*kind) as i32),
            WatchTarget::Id(id) => Err(anyhow::anyhow!(
                "unknown kind {}; to follow one Objective, run supertag watch objective ID",
                crate::terminal::text(id)
            )),
        })
        .collect::<Result<Vec<_>>>()?;
    let target = resolve_target(connection)?;
    let mut resume = args.resume_token.unwrap_or_default();
    let mut changes = 0_u64;
    let mut announced = false;
    // The reconnect window starts at the first failure after a notice was
    // last received, so a stream that opens and fails at once, again and
    // again, still ends when the window does.
    let mut disconnected_at: Option<tokio::time::Instant> = None;
    let mut delay = Duration::from_millis(250);
    loop {
        let result = async {
            // Streams are long lived: no per-request deadline applies.
            let channel = crate::network::operator_channel(
                &target
                    .endpoint(Duration::from_secs(u32::MAX as u64))
                    .await?,
            )
            .await?;
            let mut stream = client!(OperatorEventsClient, channel)
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
                disconnected_at = None;
                delay = Duration::from_millis(250);
                resume.clone_from(&event.resume_token);
                if print_event(&event, args.output, &mut announced)? {
                    changes += 1;
                    if args.limit.is_some_and(|limit| changes >= limit) {
                        return Ok::<bool, anyhow::Error>(true);
                    }
                }
            }
            Ok(false)
        }
        .await;
        let error = match result {
            Ok(true) => return Ok(()),
            Ok(false) => None,
            Err(error) => {
                // Errors a retry cannot fix end the command at once.
                if matches!(
                    error.downcast_ref::<supertag_protocol::negotiation::NegotiationError>(),
                    Some(supertag_protocol::negotiation::NegotiationError::Incompatible(_))
                ) {
                    return Err(error);
                }
                if let Some(status) = error.downcast_ref::<tonic::Status>()
                    && matches!(
                        status.code(),
                        Code::InvalidArgument
                            | Code::PermissionDenied
                            | Code::Unauthenticated
                            | Code::Unimplemented
                    )
                {
                    return Err(error);
                }
                Some(error)
            }
        };
        let since = *disconnected_at.get_or_insert_with(tokio::time::Instant::now);
        if since.elapsed() >= Duration::from_secs(args.reconnect_seconds) {
            let message = format!("Watch disconnected; resume with --resume-token {resume}");
            return Err(match error {
                Some(error) => error.context(message),
                None => anyhow::anyhow!(message),
            });
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}

fn kind_name(kind: WatchKind) -> &'static str {
    match kind {
        WatchKind::Tag => "tag",
        WatchKind::Task => "task",
        WatchKind::ConversationMessage => "conversation-message",
        WatchKind::Objective => "objective",
        WatchKind::Team => "team",
        WatchKind::WorkstreamPost => "workstream-post",
        WatchKind::Unspecified => "unknown",
    }
}

/// Prints one notice and returns whether it was a change.
fn print_event(event: &WatchEvent, output: Output, announced: &mut bool) -> Result<bool> {
    let Some(update) = &event.update else {
        return Ok(false);
    };
    Ok(match (output, update) {
        (Output::Json, Update::Heartbeat(_)) => {
            crate::terminal::print_json(
                &json!({"type": "heartbeat", "resume_token": event.resume_token}),
            )?;
            false
        }
        (Output::Json, Update::Resync(_)) => {
            crate::terminal::print_json(
                &json!({"type": "resync", "resume_token": event.resume_token}),
            )?;
            false
        }
        (Output::Json, Update::Change(change)) => {
            crate::terminal::print_json(&json!({
                "type": "change",
                "kind": kind_name(change.kind()),
                "reason": change.reason().as_str_name().trim_start_matches("WATCH_REASON_").to_ascii_lowercase(),
                "id": change.id,
                "tag_id": change.tag_id,
                "session_id": change.session_id,
                "objective_id": change.objective_id,
                "team_id": change.team_id,
                "conversation": change.conversation,
                "changed_at": Timestamp::from_millis(change.changed_at_ms).map(|at| at.to_string()),
                "resume_token": event.resume_token,
            }))?;
            true
        }
        (Output::Text, Update::Heartbeat(_)) => {
            if !*announced {
                outln!(
                    "Watching. Resume token: {}",
                    crate::terminal::text(&event.resume_token)
                );
                *announced = true;
            }
            false
        }
        (Output::Text, Update::Resync(_)) => {
            outln!(
                "Resync: changes were missed; reread current state. Resume token: {}",
                crate::terminal::text(&event.resume_token)
            );
            false
        }
        (Output::Text, Update::Change(change)) => {
            let mut line = format!(
                "{} {} {}",
                change
                    .reason()
                    .as_str_name()
                    .trim_start_matches("WATCH_REASON_")
                    .to_ascii_lowercase(),
                kind_name(change.kind()),
                crate::terminal::text(&change.id)
            );
            for (name, value) in [
                ("tag", &change.tag_id),
                ("session", &change.session_id),
                ("objective", &change.objective_id),
                ("team", &change.team_id),
            ] {
                if !value.is_empty() && value != &change.id {
                    line += &format!(" {name}={}", crate::terminal::text(value));
                }
            }
            outln!(
                "{line} (resume token {})",
                crate::terminal::text(&event.resume_token)
            );
            true
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{SpendAmount, SpendBudget, SpendGroup, SpendUnpricedModel};

    #[test]
    fn spend_text_matches_the_operator_format() {
        let report = SpendReport {
            by: SpendGrouping::Objective as i32,
            since_ms: None,
            groups: vec![
                SpendGroup {
                    key: "launch".into(),
                    attempts: 3,
                    reported_cost: vec![SpendAmount {
                        currency: "USD".into(),
                        amount_minor: 123_456,
                    }],
                    estimated_cost_attempts: 1,
                    unknown_cost_attempts: 2,
                    unpriced_models: vec![SpendUnpricedModel {
                        model: "mystery".into(),
                        attempts: 1,
                    }],
                    reported_tokens: Some(40),
                    unknown_token_attempts: 1,
                    budget: Some(SpendBudget {
                        limit_minor: 5000,
                        currency: Some("USD".into()),
                    }),
                    ..Default::default()
                },
                SpendGroup {
                    key: "unassigned".into(),
                    attempts: 1,
                    unknown_cost_attempts: 1,
                    unknown_token_attempts: 1,
                    ..Default::default()
                },
            ],
        };
        assert_eq!(
            spend_text(&report),
            "launch | 3 Attempt(s) | cost $1,234.56; 1 estimated-cost Attempt(s); 2 unknown-cost Attempt(s): unpriced: no reported or estimated cost for mystery in 1; tokens recorded; no cost reported in 1 | tokens 40; 1 unknown-token Attempt(s) | budget $50.00\n\
             unassigned | 1 Attempt(s) | cost unknown; 1 unknown-cost Attempt(s): no cost reported in 1 | tokens unknown; 1 unknown-token Attempt(s) | budget none\n"
        );
        assert_eq!(spend_text(&SpendReport::default()), "No Task Attempts.\n");
    }

    #[test]
    fn describe_text_is_readable() {
        let text = describe_text(
            "Tag",
            &json!({"tag_id":"builder","name":"Builder\u{1b}[2J","retired_at_ms":null,"allowed_actions":["read","write"],"created_at_ms":0,"workspace":{"workspace_id":"repo","mounts":[]}}),
        );
        assert_eq!(
            text,
            "Tag\nAllowed actions: read, write\nCreated at: 1970-01-01T00:00:00.000Z\nName: Builder [2J\nTag ID: builder\nWorkspace:\n  Workspace ID: repo\n"
        );
    }

    #[test]
    fn money_formats_minor_units() {
        assert_eq!(money(1234, "USD"), "$12.34");
        assert_eq!(money(500, "JPY"), "¥500");
        assert_eq!(money(5, "CAD"), "CAD 0.05");
        assert_eq!(money(5, "x"), "5 x minor units");
    }
}
