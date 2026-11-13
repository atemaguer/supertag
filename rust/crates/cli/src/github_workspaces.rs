use crate::{Connection, connect_operator, request};
use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

#[derive(Subcommand)]
pub enum WorkspaceCommand {
    /// Select a GitHub source. Moving revisions are pinned once per Session. Credentials stay on the Gateway.
    Put {
        workspace_id: String,
        /// Configured GitHub account that reads the repository.
        #[arg(long)]
        account: String,
        /// Numeric GitHub repository ID, which survives renames.
        #[arg(long)]
        repository_id: u64,
        /// Repository as OWNER/NAME; must match the repository ID.
        #[arg(long)]
        repository: String,
        /// Pin this full commit SHA.
        #[arg(long, conflicts_with = "reference")]
        commit: Option<String>,
        /// Select a branch or tag. Omit commit and ref to use the default branch.
        #[arg(long = "ref")]
        reference: Option<String>,
        /// Publish verified results as a draft pull request into this branch.
        #[arg(long)]
        pull_request_base: Option<String>,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

// Options for `supertag get workspaces`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue after the last ID the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    after_id: String,
}

// Options for `supertag delete workspace`, which deletes a GitHub Workspace source at its exact
// revision.
#[derive(Args)]
pub struct DeleteArgs {
    /// The revision you last read. The change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: u64,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
}

fn client(
    channel: ProtocolChannel,
) -> github_workspaces_client::GithubWorkspacesClient<ProtocolChannel> {
    github_workspaces_client::GithubWorkspacesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    workspace_id: String,
) -> Result<Value> {
    Ok(describe(
        client(channel)
            .get(request(GetGithubWorkspaceRequest { workspace_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListGithubWorkspacesRequest {
                limit: args.limit,
                after_id: args.after_id,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({"workspaces":page.workspaces.into_iter().map(describe).collect::<Vec<_>>(), "next_cursor":page.next_cursor}),
    )
}

pub(crate) async fn delete(
    connection: Connection,
    workspace_id: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let operation_id = args
        .operation_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    client(channel)
        .delete(request(
            DeleteGithubWorkspaceRequest {
                workspace_id: workspace_id.clone(),
                expected_revision: args.expected_revision,
                operation_id: operation_id.clone(),
            },
            &token,
        )?)
        .await?;
    Ok(json!({"workspace_id":workspace_id,"deleted":true,"operation_id":operation_id}))
}

pub async fn run(connection: Connection, command: WorkspaceCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let output = match command {
        WorkspaceCommand::Put {
            workspace_id,
            account,
            repository_id,
            repository,
            commit,
            reference,
            pull_request_base,
            expected_revision,
            operation_id,
        } => {
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let value = client
                .put(request(
                    PutGithubWorkspaceRequest {
                        operation_id: operation_id.clone(),
                        expected_revision,
                        workspace: Some(GithubWorkspace {
                            pull_request: pull_request_base
                                .map(|base_branch| GithubPullRequestDelivery { base_branch }),
                            workspace_id,
                            revision: 0,
                            source: Some(GithubWorkspaceSource {
                                account_id: account,
                                repository_id,
                                repository,
                                commit_sha: commit.unwrap_or_default(),
                                revision: reference,
                                resolved_revision: None,
                            }),
                        }),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let mut output = describe(value);
            output["operation_id"] = operation_id.into();
            output
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

pub(crate) fn describe(value: GithubWorkspace) -> Value {
    json!({"workspace_id": value.workspace_id, "revision": value.revision, "pull_request": value.pull_request.map(|delivery| json!({"base_branch":delivery.base_branch})), "source": value.source.map(|source|
        json!({"account_id":source.account_id,"repository_id":source.repository_id,"repository":source.repository,"commit_sha":source.commit_sha,"revision":source.revision,"resolved_revision":source.resolved_revision}))})
}
