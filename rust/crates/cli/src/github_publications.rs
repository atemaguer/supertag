use crate::{Connection, connect_operator, request};
use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};

#[derive(Subcommand)]
pub enum PublicationCommand {
    /// Stop further provider writes. This does not delete a branch or close a PR.
    Cancel {
        publication_id: String,
        /// Why provider writes stop; recorded with the cancellation.
        #[arg(long)]
        reason: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

// Options for `supertag get github-publications`: verified Workspace results and their separate
// GitHub publication status.
#[derive(Args)]
pub struct ListArgs {
    /// Only results of this Task.
    #[arg(long, default_value = "", conflicts_with = "id")]
    task_id: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue from the next_before_order the previous page returned.
    #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(i64).range(0..), conflicts_with = "id")]
    before_order: i64,
}

fn client(
    channel: ProtocolChannel,
) -> github_publications_client::GithubPublicationsClient<ProtocolChannel> {
    github_publications_client::GithubPublicationsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    publication_id: String,
) -> Result<Value> {
    Ok(describe(
        client(channel)
            .get(request(
                GetGithubPublicationRequest { publication_id },
                token,
            )?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListGithubPublicationsRequest {
                task_id: args.task_id,
                limit: args.limit,
                before_order: args.before_order,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({"publications":page.publications.into_iter().map(describe).collect::<Vec<_>>(),"next_before_order":page.next_before_order}),
    )
}

pub async fn run(connection: Connection, command: PublicationCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let value = match command {
        PublicationCommand::Cancel {
            publication_id,
            reason,
            operation_id,
        } => {
            let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let mut value = describe(
                client
                    .cancel(request(
                        CancelGithubPublicationRequest {
                            publication_id,
                            reason,
                            operation_id: operation_id.clone(),
                        },
                        &token,
                    )?)
                    .await?
                    .into_inner(),
            );
            value["operation_id"] = operation_id.into();
            value
        }
    };
    crate::terminal::print_json(&value)?;
    Ok(())
}
fn describe(value: GithubPublication) -> Value {
    json!({"publication_id":value.publication_id,"task_id":value.task_id,"tag_id":value.tag_id,"session_id":value.session_id,"account_id":value.account_id,"repository_id":value.repository_id,"repository":value.repository,"head_branch":value.head_branch,"base_branch":value.base_branch,"title":value.title,"body":value.body,"head_commit":value.delivery.as_ref().map(|delivery|&delivery.head_commit),"state":value.state().as_str_name(),"phase":value.phase().as_str_name(),"approval_id":value.approval_id,"reason":value.reason,"cancel_requested":value.cancel_requested,"created_order":value.created_order,"pull_request":value.pull_request.as_ref().map(|pr|json!({"number":pr.number,"url":pr.url,"head_commit":pr.head_commit,"draft":pr.draft,"open":pr.open,"merged":pr.merged}))})
}
