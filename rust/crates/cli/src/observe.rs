//! Operator observation commands: `spend`, `describe`, and `watch`.
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, ValueEnum};
use serde_json::{Value, json};
use supertag_control_plane::objective_limits::Timestamp;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        GetArtifactVolumeRequest, GetGithubWorkspaceRequest, GetHostRequest,
        GetObjectiveOverviewRequest, GetPolicyResourceRequest, GetSpendRequest, GetTagRequest,
        GetTaskRequest, GetTeamRequest, GetWorkSessionRequest, GetWorkspaceVolumeRequest,
        SpendGrouping, SpendReport, WatchEvent, WatchKind, WatchRequest,
        artifact_volumes_client::ArtifactVolumesClient,
        github_workspaces_client::GithubWorkspacesClient,
        objective_overviews_client::ObjectiveOverviewsClient, operator_client::OperatorClient,
        operator_events_client::OperatorEventsClient, policy_catalog_client::PolicyCatalogClient,
        spend_client::SpendClient, teams_client::TeamsClient, watch_event::Update,
        work_sessions_client::WorkSessionsClient, workspace_volumes_client::WorkspaceVolumesClient,
    },
};
use tonic::{Code, transport::Channel};

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
        Output::Json => println!("{}", spend_json(&report)),
        Output::Text => print!("{}", spend_text(&report)),
    }
    Ok(())
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
            terminal_text(label),
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
                        terminal_text(&model.model),
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
        _ => return format!("{minor} {} minor units", terminal_text(currency)),
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

/// Replace terminal control characters so recorded text cannot drive the terminal.
pub(crate) fn terminal_text(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { '\u{fffd}' } else { c })
        .collect()
}

#[derive(Clone, Copy, ValueEnum)]
pub enum DescribeKind {
    Tag,
    Task,
    Objective,
    Team,
    WorkerHost,
    Session,
    Role,
    PermissionSet,
    ContextSet,
    Volume,
    WorkspaceVolume,
    Workspace,
}

#[derive(Args)]
pub struct DescribeArgs {
    #[arg(value_enum)]
    kind: DescribeKind,
    /// The resource's ID or name.
    id: String,
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

macro_rules! client {
    ($client:ident, $channel:expr) => {
        $client::new($channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    };
}

pub async fn describe(connection: Connection, args: DescribeArgs) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let id = args.id;
    if matches!(args.kind, DescribeKind::Objective) {
        let view = client!(ObjectiveOverviewsClient, channel)
            .get_objective_overview(request(
                GetObjectiveOverviewRequest {
                    objective_id: id,
                    ..Default::default()
                },
                &token,
            )?)
            .await?
            .into_inner();
        match args.output {
            Output::Json => println!("{}", crate::objective_overview::json(&view)),
            Output::Text => print!("{}", crate::objective_overview::text(&view)),
        }
        return Ok(());
    }
    let (title, value) = fetch(channel, &token, args.kind, id).await?;
    match args.output {
        Output::Json => println!("{value}"),
        Output::Text => print!("{}", describe_text(title, &value)),
    }
    Ok(())
}

async fn fetch(
    channel: Channel,
    token: &str,
    kind: DescribeKind,
    id: String,
) -> Result<(&'static str, Value)> {
    Ok(match kind {
        DescribeKind::Tag => (
            "Tag",
            crate::tag_json(
                &client!(OperatorClient, channel)
                    .get_tag(request(GetTagRequest { tag_id: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::Task => (
            "Task",
            crate::task_json(
                &client!(OperatorClient, channel)
                    .get_task(request(GetTaskRequest { task_id: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::WorkerHost => (
            "Worker Host",
            crate::host_status::status_json(
                client!(OperatorClient, channel)
                    .get_host(request(GetHostRequest { host_id: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::Objective => unreachable!("describe objective renders the overview"),
        DescribeKind::Team => (
            "Team",
            crate::teams::team_json(
                client!(TeamsClient, channel)
                    .get_team(request(GetTeamRequest { team: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::Session => (
            "Work Session",
            crate::work_sessions::view(
                &client!(WorkSessionsClient, channel)
                    .get(request(
                        GetWorkSessionRequest {
                            work_session_id: id,
                            report_task_id: None,
                        },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::Role => (
            "Role",
            crate::policy::role_json(
                client!(PolicyCatalogClient, channel)
                    .get_role(request(GetPolicyResourceRequest { reference: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::PermissionSet => (
            "Permission Set",
            crate::policy::permission_json(
                client!(PolicyCatalogClient, channel)
                    .get_permission_set(request(GetPolicyResourceRequest { reference: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::ContextSet => (
            "Context Set",
            crate::policy::context_json(
                client!(PolicyCatalogClient, channel)
                    .get_context_set(request(GetPolicyResourceRequest { reference: id }, token)?)
                    .await?
                    .into_inner(),
            )?,
        ),
        DescribeKind::Volume => (
            "Volume",
            crate::volumes::volume(
                &client!(ArtifactVolumesClient, channel)
                    .get(request(GetArtifactVolumeRequest { volume_id: id }, token)?)
                    .await?
                    .into_inner(),
            ),
        ),
        DescribeKind::WorkspaceVolume => {
            let volume = WorkspaceVolumesClient::new(channel)
                .get(request(GetWorkspaceVolumeRequest { volume_id: id }, token)?)
                .await?
                .into_inner();
            (
                "Workspace Volume",
                json!({"volume_id":volume.volume_id,"source":volume.source,"revision":volume.revision}),
            )
        }
        DescribeKind::Workspace => (
            "Workspace",
            crate::github_workspaces::describe(
                client!(GithubWorkspacesClient, channel)
                    .get(request(
                        GetGithubWorkspaceRequest { workspace_id: id },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
        ),
    })
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
        Value::String(text) => terminal_text(text),
        other => other.to_string(),
    }
}

#[derive(Clone, Copy, ValueEnum)]
pub enum WatchKindArg {
    Tag,
    Task,
    ConversationMessage,
    Objective,
    Team,
    WorkstreamPost,
}

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

#[derive(Args)]
pub struct WatchArgs {
    /// Only these kinds of change. Repeat for more; omit for every kind.
    #[arg(long = "kind", value_enum)]
    kinds: Vec<WatchKindArg>,
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
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

/// Streams change notices. A dropped connection is resumed from the last
/// resume token, so no notice is missed or repeated across reconnects; a
/// resync notice means the feed moved past the token and state must be reread.
pub async fn watch(connection: Connection, args: WatchArgs) -> Result<()> {
    let target = resolve_target(connection)?;
    let kinds = args
        .kinds
        .iter()
        .map(|kind| WatchKind::from(*kind) as i32)
        .collect::<Vec<_>>();
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
            let channel = target
                .endpoint(Duration::from_secs(u32::MAX as u64))
                .await?
                .connect()
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
                if print_event(&event, args.output, &mut announced) {
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
fn print_event(event: &WatchEvent, output: Output, announced: &mut bool) -> bool {
    let Some(update) = &event.update else {
        return false;
    };
    match (output, update) {
        (Output::Json, Update::Heartbeat(_)) => {
            println!(
                "{}",
                json!({"type": "heartbeat", "resume_token": event.resume_token})
            );
            false
        }
        (Output::Json, Update::Resync(_)) => {
            println!(
                "{}",
                json!({"type": "resync", "resume_token": event.resume_token})
            );
            false
        }
        (Output::Json, Update::Change(change)) => {
            println!(
                "{}",
                json!({
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
                })
            );
            true
        }
        (Output::Text, Update::Heartbeat(_)) => {
            if !*announced {
                println!("Watching. Resume token: {}", event.resume_token);
                *announced = true;
            }
            false
        }
        (Output::Text, Update::Resync(_)) => {
            println!(
                "Resync: changes were missed; reread current state. Resume token: {}",
                event.resume_token
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
                terminal_text(&change.id)
            );
            for (name, value) in [
                ("tag", &change.tag_id),
                ("session", &change.session_id),
                ("objective", &change.objective_id),
                ("team", &change.team_id),
            ] {
                if !value.is_empty() && value != &change.id {
                    line += &format!(" {name}={}", terminal_text(value));
                }
            }
            println!("{line} (resume token {})", event.resume_token);
            true
        }
    }
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
            "Tag\nAllowed actions: read, write\nCreated at: 1970-01-01T00:00:00.000Z\nName: Builder\u{fffd}[2J\nTag ID: builder\nWorkspace:\n  Workspace ID: repo\n"
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
