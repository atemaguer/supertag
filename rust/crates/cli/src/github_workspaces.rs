use crate::{Connection, connect_operator, request};
use anyhow::Result;
use clap::Subcommand;
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

#[derive(Subcommand)]
pub enum GithubWorkspaceCommand {
    /// Register or update an immutable GitHub source. Credentials stay on the Gateway.
    Put {
        workspace_id: String,
        #[arg(long)]
        account: String,
        #[arg(long)]
        repository_id: u64,
        #[arg(long)]
        repository: String,
        #[arg(long)]
        commit: String,
        /// Publish verified results as a draft pull request into this branch.
        #[arg(long)]
        pull_request_base: Option<String>,
        #[arg(long)]
        expected_revision: Option<u64>,
        #[arg(long)]
        operation_id: Option<String>,
    },
    Get {
        workspace_id: String,
    },
    List {
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value = "")]
        after_id: String,
    },
    Delete {
        workspace_id: String,
        #[arg(long)]
        expected_revision: u64,
        #[arg(long)]
        operation_id: Option<String>,
    },
}

pub async fn run(connection: Connection, command: GithubWorkspaceCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = github_workspaces_client::GithubWorkspacesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        GithubWorkspaceCommand::Put {
            workspace_id,
            account,
            repository_id,
            repository,
            commit,
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
                                commit_sha: commit,
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
        GithubWorkspaceCommand::Get { workspace_id } => describe(
            client
                .get(request(GetGithubWorkspaceRequest { workspace_id }, &token)?)
                .await?
                .into_inner(),
        ),
        GithubWorkspaceCommand::List { limit, after_id } => {
            let page = client
                .list(request(
                    ListGithubWorkspacesRequest { limit, after_id },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({"workspaces":page.workspaces.into_iter().map(describe).collect::<Vec<_>>(), "next_cursor":page.next_cursor})
        }
        GithubWorkspaceCommand::Delete {
            workspace_id,
            expected_revision,
            operation_id,
        } => {
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            client
                .delete(request(
                    DeleteGithubWorkspaceRequest {
                        workspace_id: workspace_id.clone(),
                        expected_revision,
                        operation_id: operation_id.clone(),
                    },
                    &token,
                )?)
                .await?;
            json!({"workspace_id":workspace_id,"deleted":true,"operation_id":operation_id})
        }
    };
    println!("{output}");
    Ok(())
}

fn describe(value: GithubWorkspace) -> Value {
    json!({"workspace_id": value.workspace_id, "revision": value.revision, "pull_request": value.pull_request.map(|delivery| json!({"base_branch":delivery.base_branch})), "source": value.source.map(|source|
        json!({"account_id":source.account_id,"repository_id":source.repository_id,"repository":source.repository,"commit_sha":source.commit_sha}))})
}
