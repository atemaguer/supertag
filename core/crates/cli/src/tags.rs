//! `supertag tag put|retire`, and the Tag reads behind `supertag get tag`.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ApprovalRule, GetTagRequest, HarnessKind, ListTagsRequest, PolicyExecutionSettings,
        PutTagRequest, RetireTagRequest, StartRate, WorkspaceSpec, operator_client::OperatorClient,
    },
};

use crate::{Connection, connect_operator, harness::Harness, request, tag_json};

#[derive(Subcommand)]
pub enum TagCommand {
    /// Set the instructions and allowed actions for a Tag.
    Put(Box<PutArgs>),
    /// Retire a Tag by ID while preserving its work history.
    Retire {
        tag_id: String,
        /// Show blockers and what retirement would detach.
        #[arg(long)]
        dry_run: bool,
    },
    /// Change where a Tag works: add or remove its location on a connected surface. Its own
    /// --control-plane, --state-directory, and --file name the local configuration it edits.
    #[command(
        after_help = "The local Gateway serves one location per Surface Account and one per provider; remove a location before adding another."
    )]
    Update(Box<crate::surface_setup::UpdateTag>),
}

#[derive(Args)]
pub struct PutArgs {
    tag_id: String,
    /// Display name. Defaults to the Tag ID for a new Tag.
    #[arg(long = "name")]
    display_name: Option<String>,
    /// Standing instructions the Tag follows in every Task.
    #[arg(long)]
    instructions: String,
    /// Action the Tag may take, such as files:read. Repeat for each action.
    #[arg(long)]
    allow: Vec<String>,
    /// Require approval before this Tag posts to a Team Workstream.
    #[arg(long)]
    require_workstream_approval: bool,
    /// Bare operator ID eligible to approve. Omit to allow any eligible operator.
    #[arg(long, requires = "require_workstream_approval")]
    workstream_approver: Vec<String>,
    /// Require approval before this Tag sends a direct message.
    #[arg(long)]
    require_mailbox_approval: bool,
    /// Bare operator ID eligible to approve a direct message.
    #[arg(long, requires = "require_mailbox_approval")]
    mailbox_approver: Vec<String>,
    /// Logical local or configured GitHub repository binding.
    #[arg(long)]
    workspace_id: Option<String>,
    /// Full local Git base commit every Session starts from. Omit for a remote Workspace.
    #[arg(long, requires = "workspace_id", conflicts_with = "workspace_ref")]
    workspace_base: Option<String>,
    /// Local Git branch whose current commit each new Session starts from, such as main.
    #[arg(long, requires = "workspace_id")]
    workspace_ref: Option<String>,
    /// JSON array of {volumeId,destination,maxBytes,access} for Workspace Volume copies; maxBytes
    /// defaults to 1 GiB (at most 20 GiB); access is read-only (default) or read-write.
    #[arg(long, requires = "workspace_id")]
    workspace_mounts: Option<PathBuf>,
    /// A server the Workspace's `.mcp.json` declares that this Tag's Tasks may use, read
    /// from the Task's base commit. May be repeated.
    #[arg(long = "workspace-mcp", requires = "workspace_id")]
    workspace_mcp: Vec<String>,
    /// Required harness for Tasks accepted from this Tag.
    #[arg(long)]
    harness: Option<Harness>,
    /// Allowed model IDs, with the default first. May be repeated.
    #[arg(long = "model", value_delimiter = ',')]
    models: Vec<String>,
    /// Allowed reasoning efforts, with the default first. May be repeated.
    #[arg(long = "effort", value_delimiter = ',')]
    efforts: Vec<String>,
    /// Require this fixed execution environment for new Cursor Sessions.
    #[arg(long, conflicts_with = "workspace_id")]
    shared_execution_environment: Option<String>,
    /// Make this the Control Plane's lead Tag, or with false, stop it being the lead. Omit to keep
    /// it as it is. At most one Tag is the lead.
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    lead: Option<bool>,
    /// How many Work Sessions the Tag may have open at once, across all its conversations, from 1
    /// to 64. Omit to keep it as it is; a new Tag gets 8.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=64))]
    max_work_sessions: Option<u32>,
    /// Keep memory: notes the Tag writes and a daily review of its work. With false, the Tag
    /// keeps no notes and does not review. Omit to keep it as it is; a new Tag keeps memory.
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    memory: Option<bool>,
    /// At most how many of the Tag's Task Attempts start per period, as STARTS/PERIOD such as
    /// 10/1h (periods in m, h, or d, from 1m to 7d), or none to remove it. A Task over it waits;
    /// a person's message always starts. Omit to keep it as it is; a new Tag has none.
    #[arg(long, value_parser = parse_start_rate)]
    start_rate: Option<StartRate>,
    /// The Volume that keeps the Tag's work beyond any one Worker Host: a copy of every capture,
    /// written by the capturing host directly. none removes it. A capture fails when its copy
    /// cannot be written. Omit to keep it as it is; a new Tag has none.
    #[arg(long, value_name = "VOLUME", value_parser = parse_volume)]
    volume: Option<String>,
}

/// A Volume ID, or `none`, which removes the Tag's Volume.
fn parse_volume(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("none") {
        return Ok(String::new());
    }
    if value.is_empty() {
        return Err("name a Volume, or none".into());
    }
    Ok(value.to_owned())
}

/// `STARTS/PERIOD`, such as `10/1h`, or `none`, which removes the limit.
pub(crate) fn parse_start_rate(value: &str) -> Result<StartRate, String> {
    if value.trim().eq_ignore_ascii_case("none") {
        return Ok(StartRate::default());
    }
    let refused = || format!("{value:?} is not STARTS/PERIOD, such as 10/1h, or none");
    let (starts, period) = value.trim().split_once('/').ok_or_else(refused)?;
    let starts: u32 = starts.trim().parse().map_err(|_| refused())?;
    let period = period.trim();
    let (count, unit) = period.split_at(period.len().saturating_sub(1));
    let count: u64 = count.parse().map_err(|_| refused())?;
    let unit_ms = match unit {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return Err(refused()),
    };
    let per_ms = count.checked_mul(unit_ms).ok_or_else(refused)?;
    if !(1..=10_000).contains(&starts) {
        return Err("a start rate allows 1 to 10,000 starts".into());
    }
    if !(60_000..=7 * 86_400_000).contains(&per_ms) {
        return Err("a start rate's period is 1m to 7d".into());
    }
    Ok(StartRate { starts, per_ms })
}

/// A start rate as `10/1h`.
pub(crate) fn start_rate_text(rate: &StartRate) -> String {
    let per = rate.per_ms / 60_000;
    let period = if per.is_multiple_of(1440) {
        format!("{}d", per / 1440)
    } else if per.is_multiple_of(60) {
        format!("{}h", per / 60)
    } else {
        format!("{per}m")
    };
    format!("{}/{period}", rate.starts)
}

// Options for `supertag get tags`: active Tags, and optionally retired identities.
#[derive(Args)]
pub struct ListArgs {
    /// Also list retired Tags.
    #[arg(long, conflicts_with = "id")]
    include_retired: bool,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 100, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> OperatorClient<ProtocolChannel> {
    OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: TagCommand) -> Result<()> {
    let command = match command {
        // tag update edits local configuration first and connects on its own.
        TagCommand::Update(args) => return crate::surface_setup::update_tag(*args).await,
        command => command,
    };
    let (channel, token) = connect_operator(connection).await?;
    let mut operator = client(channel);
    let output = match command {
        TagCommand::Update(_) => unreachable!("handled above"),
        TagCommand::Put(args) => {
            let PutArgs {
                tag_id,
                display_name,
                instructions,
                mut allow,
                require_workstream_approval,
                workstream_approver,
                require_mailbox_approval,
                mailbox_approver,
                workspace_id,
                workspace_base,
                workspace_ref,
                workspace_mounts,
                workspace_mcp,
                harness,
                models,
                efforts,
                shared_execution_environment,
                lead,
                max_work_sessions,
                memory,
                start_rate,
                volume,
            } = *args;
            let mounts = workspace_mounts
                .as_deref()
                .map(crate::workspace_mounts::read_declarations)
                .transpose()?
                .unwrap_or_default();
            let workspace = workspace_id.map(|workspace_id| WorkspaceSpec {
                mcp_servers: workspace_mcp,
                workspace_id,
                base_commit: workspace_base.unwrap_or_default(),
                base_ref: workspace_ref.unwrap_or_default(),
                mounts,
                ..Default::default()
            });
            let mut approval_rules = Vec::new();
            for (required, action, operator_ids) in [
                (
                    require_workstream_approval,
                    "workstream:post",
                    workstream_approver,
                ),
                (require_mailbox_approval, "mailbox:send", mailbox_approver),
            ] {
                if !required {
                    continue;
                }
                let action = action.to_string();
                allow.push(action.clone());
                approval_rules.push(ApprovalRule {
                    action,
                    operator_ids,
                });
            }
            let tag = operator
                .put_tag(request(
                    PutTagRequest {
                        tag_id,
                        name: display_name,
                        instructions,
                        allowed_actions: allow,
                        workspace,
                        harness_kind: harness.map_or(HarnessKind::Unspecified, Harness::kind)
                            as i32,
                        approval_rules,
                        expected_revision: None,
                        lead,
                        max_work_sessions,
                        memory,
                        execution: (!models.is_empty()
                            || !efforts.is_empty()
                            || shared_execution_environment.is_some())
                        .then_some(PolicyExecutionSettings {
                            models,
                            efforts,
                            harness: None,
                            shared_execution_environment_id: shared_execution_environment,
                        }),
                        start_rate,
                        volume,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({
                "tag_id": tag.tag_id,
                "name": tag.name,
                "revision": tag.revision,
                "lead": tag.lead,
                "max_work_sessions": tag.max_work_sessions,
                "memory": tag.memory,
                "start_rate": tag.start_rate.as_ref().map(start_rate_text),
                "volume": (!tag.volume.is_empty()).then_some(&tag.volume),
            })
        }
        TagCommand::Retire { tag_id, dry_run } => {
            let response = operator
                .retire_tag(request(RetireTagRequest { tag_id, dry_run }, &token)?)
                .await?
                .into_inner();
            json!({
                "tag": response.tag.as_ref().map(tag_json),
                "dry_run": dry_run,
                "blockers": response.blockers,
                "surface_locations": response.surface_locations,
                "host_bindings": response.host_bindings,
                "mailbox_grants": response.mailbox_grants,
                "role_assignments": response.role_assignments,
            })
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

/// A Tag by its permanent ID, including after retirement.
pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, tag_id: String) -> Result<Value> {
    Ok(tag_json(
        &client(channel)
            .get_tag(request(GetTagRequest { tag_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_tags(request(
            ListTagsRequest {
                limit: args.limit,
                cursor: args.cursor,
                include_retired: args.include_retired,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "tags": page.tags.iter().map(tag_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

#[cfg(test)]
mod start_rate_tests {
    use super::*;

    #[test]
    fn start_rates_parse_as_starts_per_period() {
        let rate = parse_start_rate("10/1h").unwrap();
        assert_eq!((rate.starts, rate.per_ms), (10, 3_600_000));
        assert_eq!(start_rate_text(&rate), "10/1h");
        assert_eq!(parse_start_rate(" 3/90m ").unwrap().per_ms, 90 * 60_000);
        assert_eq!(start_rate_text(&parse_start_rate("1/7d").unwrap()), "1/7d");
        assert_eq!(parse_start_rate("none").unwrap().starts, 0);
        for refused in [
            "0/1h", "10/30s", "10/8d", "10", "ten/1h", "10/h", "10001/1h",
        ] {
            assert!(parse_start_rate(refused).is_err(), "{refused}");
        }
    }
}
