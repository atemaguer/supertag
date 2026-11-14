use anyhow::{Result, ensure};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::Code;
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum TeamCommand {
    /// Create a Team from existing Tags.
    Create {
        team_id: String,
        /// Display name. Defaults to the Team ID.
        #[arg(long)]
        name: Option<String>,
        /// Member Tag ID. Repeat for each member.
        #[arg(long, required = true)]
        member: Vec<String>,
        /// Most Tasks the Team runs at once. Omit for no Team limit.
        #[arg(long)]
        max_concurrency: Option<u32>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Replace the selected fields of a Team.
    Update {
        team: String,
        /// New display name.
        #[arg(long)]
        name: Option<String>,
        /// Replace the members with these Tag IDs. Repeat for each member.
        #[arg(long)]
        member: Vec<String>,
        /// Most Tasks the Team runs at once.
        #[arg(long, conflicts_with = "clear_concurrency", value_parser = clap::value_parser!(u32).range(1..=1000))]
        max_concurrency: Option<u32>,
        /// Remove the Team concurrency limit.
        #[arg(long)]
        clear_concurrency: bool,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

// Options for `supertag get teams`.
#[derive(Args)]
pub struct ListArgs {
    /// Only Teams this Tag belongs to.
    #[arg(long, default_value = "", conflicts_with = "id")]
    member: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 32, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

// Options for `supertag get workstream-posts`: the newest posts of one Team's Workstream, or
// those after a sequence.
#[derive(Args)]
pub struct PostListArgs {
    /// The Team whose Workstream to read, by ID or name.
    #[arg(long)]
    team: String,
    /// Continue after this post sequence instead of reading the newest posts.
    #[arg(long)]
    after_sequence: Option<u64>,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 16)]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "")]
    cursor: String,
}

// Options for `supertag delete team`.
#[derive(Args)]
pub struct DeleteArgs {
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
}

fn client(channel: ProtocolChannel) -> teams_client::TeamsClient<ProtocolChannel> {
    teams_client::TeamsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, team: String) -> Result<Value> {
    Ok(team_json(get(&mut client(channel), token, team).await?))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_teams(request(
            ListTeamsRequest {
                member_tag_id: args.member,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({ "teams": page.teams.into_iter().map(team_json).collect::<Vec<_>>(), "next_cursor": page.next_cursor }),
    )
}

/// Deletes a Team and its Workstream after its Objectives close.
pub(crate) async fn list_posts(connection: Connection, args: PostListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_workstream_posts(request(
            ListWorkstreamPostsRequest {
                team: args.team,
                after_sequence: args.after_sequence,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({ "posts": page.posts.into_iter().map(post_json).collect::<Vec<_>>(), "next_cursor": page.next_cursor }),
    )
}

pub(crate) async fn delete(
    connection: Connection,
    team: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let input = DeleteTeamRequest {
        team,
        operation_id: operation(args.operation_id),
    };
    Ok(team_json(
        client(channel)
            .delete_team(request(input, &token)?)
            .await?
            .into_inner(),
    ))
}

pub async fn run(connection: Connection, command: TeamCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let output = match command {
        TeamCommand::Create {
            team_id,
            name,
            member,
            max_concurrency,
            operation_id,
        } => {
            let name = name.unwrap_or_else(|| team_id.clone());
            let input = CreateTeamRequest {
                team_id,
                name,
                member_tag_ids: member,
                max_concurrency,
                operation_id: operation(operation_id),
            };
            team_json(
                client
                    .create_team(request(input, &token)?)
                    .await?
                    .into_inner(),
            )
        }
        TeamCommand::Update {
            team,
            name,
            member,
            max_concurrency,
            clear_concurrency,
            expected_revision,
            operation_id,
        } => {
            ensure!(
                name.is_some()
                    || !member.is_empty()
                    || max_concurrency.is_some()
                    || clear_concurrency,
                "set at least one of --name, --member, --max-concurrency or --clear-concurrency"
            );
            let mut input = UpdateTeamRequest {
                operation_id: operation(operation_id),
                team,
                expected_revision: expected_revision.unwrap_or_default(),
                name,
                members: (!member.is_empty()).then_some(TeamMembers { tag_ids: member }),
                max_concurrency: if clear_concurrency {
                    Some(0)
                } else {
                    max_concurrency
                },
            };
            let observed = if expected_revision.is_none() {
                let current = get(&mut client, &token, input.team.clone()).await?;
                input.expected_revision = current.revision;
                input.team = current.team_id.clone();
                Some(current)
            } else {
                None
            };
            let outcome = client.update_team(request(input.clone(), &token)?).await;
            let updated = match (outcome, observed) {
                (Err(error), Some(before)) if error.code() == Code::FailedPrecondition => {
                    let current = get(&mut client, &token, input.team.clone()).await?;
                    if !unchanged_fields(&input, &before, &current) {
                        return Err(error.into());
                    }
                    input.expected_revision = current.revision;
                    client.update_team(request(input, &token)?).await?
                }
                (outcome, _) => outcome?,
            };
            team_json(updated.into_inner())
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

async fn get(
    client: &mut teams_client::TeamsClient<ProtocolChannel>,
    token: &str,
    team: String,
) -> Result<Team> {
    Ok(client
        .get_team(request(GetTeamRequest { team }, token)?)
        .await?
        .into_inner())
}

fn unchanged_fields(request: &UpdateTeamRequest, before: &Team, current: &Team) -> bool {
    (request.name.is_none() || before.name == current.name)
        && (request.members.is_none() || before.member_tag_ids == current.member_tag_ids)
        && (request.max_concurrency.is_none() || before.max_concurrency == current.max_concurrency)
}

fn operation(value: Option<String>) -> String {
    value.unwrap_or_else(|| Uuid::new_v4().to_string())
}

pub(crate) fn team_json(team: Team) -> Value {
    json!({
        "team_id": team.team_id,
        "name": team.name,
        "member_tag_ids": team.member_tag_ids,
        "max_concurrency": team.max_concurrency,
        "revision": team.revision,
        "created_at_ms": team.created_at_ms,
        "updated_at_ms": team.updated_at_ms,
    })
}

fn post_json(post: WorkstreamPost) -> Value {
    json!({
        "post_id": post.post_id,
        "team_id": post.team_id,
        "author_tag_id": post.author_tag_id,
        "to_tag_ids": post.to_tag_ids,
        "body": post.body,
        "source_task_id": post.source_task_id,
        "sequence": post.sequence,
        "created_at_ms": post.created_at_ms,
    })
}
