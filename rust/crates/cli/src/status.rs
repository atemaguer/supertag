//! `supertag status` and `supertag version`.
use std::path::PathBuf;

use anyhow::Result;
use clap::Args;
use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        HostPhase, ListHostsRequest, ListInboxItemsRequest, ListObjectivesRequest, ListTagsRequest,
        ObjectiveStatus, inbox_client::InboxClient, objectives_client::ObjectivesClient,
        operator_client::OperatorClient,
    },
};

use crate::{
    Connection,
    lifecycle::{self, Output, Supervisor},
    local_config,
};

const PAGE: u32 = 100;
/// Bounds every listing so one command cannot page forever.
const MAX_PAGES: usize = 100;

#[derive(Args)]
pub struct StatusArgs {
    /// Remote Gateway; reads SUPERTAG_OPERATOR_TOKEN.
    #[arg(long, conflicts_with = "state_directory")]
    gateway: Option<String>,
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value_t)]
    output: Output,
}

#[derive(Serialize)]
struct StatusView {
    worker_hosts: Vec<HostView>,
    tags: Vec<TagView>,
    objectives: Vec<ObjectiveView>,
    inbox: InboxView,
}

#[derive(Serialize)]
struct HostView {
    id: String,
    phase: String,
    draining: bool,
    running: u32,
    capacity: u32,
    harness: String,
}

#[derive(Serialize)]
struct TagView {
    id: String,
    name: String,
    harness: String,
}

#[derive(Serialize)]
struct ObjectiveView {
    id: String,
    status: String,
    owner: String,
    spent_minor: Option<u64>,
    budget_limit_minor: Option<u64>,
    currency: Option<String>,
    deadline_ms: Option<i64>,
    needs_operator: usize,
}

#[derive(Serialize)]
struct InboxView {
    items: usize,
    truncated: bool,
}

fn connection(gateway: Option<String>, state_directory: Option<PathBuf>) -> Result<Connection> {
    Ok(match gateway {
        Some(gateway) => Connection {
            gateway: Some(gateway),
            state_directory: None,
        },
        // `supertag --gateway URL status` selects the Gateway before the command name.
        None if state_directory.is_none() && crate::ROOT_GATEWAY.get().is_some() => Connection {
            gateway: None,
            state_directory: None,
        },
        None => Connection {
            gateway: None,
            state_directory: Some(local_config::state_directory(state_directory)?),
        },
    })
}

/// What the organization is doing now: Worker Hosts, Tags, unfinished Objectives, and the
/// operator inbox, read through the Gateway's operator API.
pub async fn status(args: StatusArgs) -> Result<()> {
    let (channel, token) =
        crate::connect_operator(connection(args.gateway, args.state_directory)?).await?;
    let mut operator = OperatorClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut objectives_client = ObjectivesClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut inbox = InboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);

    let mut hosts = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let page = operator
            .list_hosts(crate::request(
                ListHostsRequest {
                    limit: PAGE,
                    cursor: cursor.clone(),
                },
                &token,
            )?)
            .await?
            .into_inner();
        hosts.extend(
            page.hosts
                .into_iter()
                .filter(|host| host.revoked_at_ms.is_none()),
        );
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    let mut tags = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let page = operator
            .list_tags(crate::request(
                ListTagsRequest {
                    limit: PAGE,
                    cursor: cursor.clone(),
                    include_retired: false,
                },
                &token,
            )?)
            .await?
            .into_inner();
        tags.extend(page.tags);
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    let mut objectives = Vec::new();
    let mut after = String::new();
    for _ in 0..MAX_PAGES {
        let page = objectives_client
            .list_objectives(crate::request(
                ListObjectivesRequest {
                    limit: PAGE,
                    after_id: after.clone(),
                },
                &token,
            )?)
            .await?
            .into_inner()
            .objectives;
        let full = page.len() as u32 == PAGE;
        if let Some(last) = page.last() {
            after = last.objective_id.clone();
        }
        objectives.extend(page.into_iter().filter(|objective| {
            !matches!(
                objective.status(),
                ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
            )
        }));
        if !full {
            break;
        }
    }
    let mut items = Vec::new();
    let mut truncated = false;
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let page = inbox
            .list_items(crate::request(
                ListInboxItemsRequest {
                    page_size: PAGE,
                    cursor: cursor.clone(),
                    ..Default::default()
                },
                &token,
            )?)
            .await?
            .into_inner();
        truncated |= !page.truncated_kinds.is_empty();
        items.extend(
            page.items
                .into_iter()
                .filter(|item| item.operator_eligible)
                .map(|item| item.objective_id),
        );
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    let view = StatusView {
        worker_hosts: hosts
            .iter()
            .map(|host| HostView {
                id: host.host_id.clone(),
                phase: phase(host.phase()).into(),
                draining: host.draining,
                running: host.active_attempts,
                capacity: host.capacity,
                harness: harness(host.harness_kind().as_str_name()),
            })
            .collect(),
        tags: tags
            .iter()
            .map(|tag| TagView {
                id: tag.tag_id.clone(),
                name: tag.name.clone(),
                harness: harness(tag.harness_kind().as_str_name()),
            })
            .collect(),
        objectives: objectives
            .iter()
            .map(|objective| ObjectiveView {
                id: objective.objective_id.clone(),
                status: objective
                    .status()
                    .as_str_name()
                    .trim_start_matches("OBJECTIVE_STATUS_")
                    .to_ascii_lowercase()
                    .replace('_', " "),
                owner: objective.owner_tag_id.clone(),
                spent_minor: objective.reported_spend_minor,
                budget_limit_minor: objective.budget_limit_minor,
                currency: objective.budget_currency.clone(),
                deadline_ms: objective.deadline_ms,
                needs_operator: items
                    .iter()
                    .filter(|id| **id == objective.objective_id)
                    .count(),
            })
            .collect(),
        inbox: InboxView {
            items: items.len(),
            truncated,
        },
    };
    match args.output {
        Output::Json => crate::terminal::print_json_pretty(&view)?,
        Output::Text => out!("{}", format_status(&view, now_ms())),
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn phase(phase: HostPhase) -> &'static str {
    match phase {
        HostPhase::Unspecified => "unknown",
        HostPhase::Pending => "pending",
        HostPhase::Ready => "ready",
        HostPhase::Busy => "busy",
        HostPhase::Suppressed => "suppressed",
        HostPhase::Offline => "offline",
        HostPhase::Draining => "draining",
        HostPhase::Revoked => "revoked",
    }
}

fn harness(name: &str) -> String {
    match name.trim_start_matches("HARNESS_KIND_") {
        "UNSPECIFIED" => "any harness".into(),
        other => other.to_ascii_lowercase().replace('_', "-"),
    }
}

fn format_status(view: &StatusView, now_ms: i64) -> String {
    let mut lines = vec!["Worker Hosts".to_owned()];
    if view.worker_hosts.is_empty() {
        lines.push("  none; add one with supertag up".into());
    }
    for host in &view.worker_hosts {
        lines.push(format!(
            "  {}  {}{}  {}/{} Task Attempts running ({})",
            host.id,
            host.phase,
            if host.draining && host.phase != "draining" {
                ", draining"
            } else {
                ""
            },
            host.running,
            host.capacity,
            host.harness
        ));
    }
    lines.push(String::new());
    lines.push("Tags".into());
    if view.tags.is_empty() {
        lines.push("  none".into());
    }
    for tag in &view.tags {
        let name = if tag.name.is_empty() || tag.name == tag.id {
            String::new()
        } else {
            format!(" ({})", tag.name)
        };
        lines.push(format!("  {}{name}  {}", tag.id, tag.harness));
    }
    lines.push(String::new());
    lines.push("Objectives not finished".into());
    if view.objectives.is_empty() {
        lines.push("  none".into());
    }
    for objective in &view.objectives {
        let mut details = vec![
            objective.status.clone(),
            format!("owner {}", objective.owner),
        ];
        details.push(match (objective.budget_limit_minor, &objective.currency) {
            (Some(limit), Some(currency)) => format!(
                "{} of {limit} {currency} minor units",
                objective.spent_minor.unwrap_or(0)
            ),
            (Some(limit), None) => format!(
                "{} of {limit} budget units",
                objective.spent_minor.unwrap_or(0)
            ),
            (None, _) => "no budget".into(),
        });
        details.push(match objective.deadline_ms {
            None => "no deadline".into(),
            Some(deadline) => {
                let minutes = (deadline - now_ms) / 60_000;
                if minutes >= 0 {
                    format!("deadline in {}", span(minutes))
                } else {
                    format!("deadline passed {} ago", span(-minutes))
                }
            }
        });
        if objective.needs_operator > 0 {
            details.push(format!("{} need you", objective.needs_operator));
        }
        lines.push(format!("  {}  {}", objective.id, details.join("; ")));
    }
    lines.push(String::new());
    lines.push(if view.inbox.items == 0 && !view.inbox.truncated {
        "Operator inbox: empty".into()
    } else {
        format!(
            "Operator inbox: {}{} {}; see supertag get inbox-items",
            if view.inbox.truncated {
                "at least "
            } else {
                ""
            },
            view.inbox.items,
            if view.inbox.items == 1 {
                "item"
            } else {
                "items"
            }
        )
    });
    lines
        .into_iter()
        .map(|line| format!("{}\n", crate::terminal::text(&line)))
        .collect()
}

fn span(minutes: i64) -> String {
    let hours = minutes / 60;
    if hours >= 48 {
        format!("{}d", hours / 24)
    } else if hours > 0 {
        format!("{hours}h {}m", minutes % 60)
    } else {
        format!("{minutes}m")
    }
}

#[derive(Args)]
pub struct VersionArgs {
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value_t)]
    output: Output,
}

#[derive(Serialize)]
struct VersionReport {
    cli: String,
    local_services: LocalVersion,
}

#[derive(Serialize)]
struct LocalVersion {
    running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matches_cli: Option<bool>,
}

/// This CLI's version, and the version of the local services when they run.
pub fn version(args: VersionArgs) -> Result<()> {
    let cli = env!("CARGO_PKG_VERSION").to_owned();
    let state = local_config::state_directory(args.state_directory)?;
    let local_services = match lifecycle::inspect(&state)? {
        Supervisor::Running(status) => LocalVersion {
            running: true,
            matches_cli: Some(status.version == cli),
            version: Some(status.version),
            pid: Some(status.pid),
        },
        _ => LocalVersion {
            running: false,
            version: None,
            pid: None,
            matches_cli: None,
        },
    };
    let report = VersionReport {
        cli,
        local_services,
    };
    match args.output {
        Output::Json => crate::terminal::print_json_pretty(&report)?,
        Output::Text => {
            outln!("supertag {}", report.cli);
            match (&report.local_services.version, report.local_services.pid) {
                (Some(version), Some(pid)) => {
                    outln!("Local services: {version} (process {pid})");
                    if report.local_services.matches_cli == Some(false) {
                        outln!(
                            "The local services run a different version; restart them with supertag down and supertag up."
                        );
                    }
                }
                _ => outln!("Local services: not running"),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_text_names_every_section_and_neutralizes_terminal_escapes() {
        let view = StatusView {
            worker_hosts: vec![HostView {
                id: "laptop".into(),
                phase: "ready".into(),
                draining: false,
                running: 1,
                capacity: 2,
                harness: "codex".into(),
            }],
            tags: vec![TagView {
                id: "lead".into(),
                name: "Lead\u{1b}[31m".into(),
                harness: "codex".into(),
            }],
            objectives: vec![ObjectiveView {
                id: "ship".into(),
                status: "working".into(),
                owner: "lead".into(),
                spent_minor: Some(120),
                budget_limit_minor: Some(1000),
                currency: Some("USD".into()),
                deadline_ms: Some(3 * 3_600_000 + 5 * 60_000),
                needs_operator: 2,
            }],
            inbox: InboxView {
                items: 2,
                truncated: false,
            },
        };
        let text = format_status(&view, 0);
        assert!(
            text.contains("  laptop  ready  1/2 Task Attempts running (codex)\n"),
            "{text}"
        );
        assert!(!text.contains('\u{1b}'), "{text}");
        assert!(text.contains("  ship  working; owner lead; 120 of 1000 USD minor units; deadline in 3h 5m; 2 need you\n"), "{text}");
        assert!(
            text.ends_with("Operator inbox: 2 items; see supertag get inbox-items\n"),
            "{text}"
        );
    }
}
