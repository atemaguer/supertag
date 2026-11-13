use crate::{Connection, connect_operator, request};
use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
#[derive(Subcommand)]
pub enum PublicationCommand {
    /// Approve selected completed output for named destination Objectives.
    Publish {
        publication_id: String,
        artifact_id: String,
        /// File in the artifact to publish. Repeat for each file.
        #[arg(long, required = true)]
        path: Vec<String>,
        /// Destination Objective ID that may use the files. Repeat for each Objective.
        #[arg(long, required = true)]
        audience: Vec<String>,
        /// Earlier publication that this one replaces.
        #[arg(long)]
        supersedes: Option<String>,
    },
    /// Approve consumption by a destination already in the publication audience.
    Consume {
        consumption_id: String,
        publication_id: String,
        objective_id: String,
    },
    /// Withdraw a publication at its exact revision, so later Tasks cannot use it.
    Withdraw {
        publication_id: String,
        /// The revision you last read. The change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Withdraw a consumption approval at its exact revision.
    WithdrawConsumption {
        consumption_id: String,
        /// The revision you last read. The change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: u64,
    },
    /// List the recorded events for one publication or consumption approval.
    Audit {
        approval_type: String,
        approval_id: String,
    },
}
fn files(files: &[ArtifactFile]) -> Value {
    json!(files.iter().map(|f|json!({"path":f.path,"blob":f.blob.as_ref().map(|b|json!({"sha256":b.sha256,"byte_length":b.byte_length}))})).collect::<Vec<_>>())
}
fn publication(p: &ArtifactPublication) -> Value {
    json!({"publication_id":p.publication_id,"source_objective_id":p.source_objective_id,"producer":p.producer.as_ref().map(|s|json!({"task_id":s.task_id,"attempt_id":s.attempt_id,"tag_id":s.tag_id,"session_id":s.session_id})),"artifact_id":p.artifact_id,"files":files(&p.files),"audience_objective_ids":p.audience_objective_ids,"assessment":p.assessment,"source_owner_tag_id":p.source_owner_tag_id,"approved_by":p.approved_by,"approved_at_ms":p.approved_at_ms,"supersedes_publication_id":p.supersedes_publication_id,"status":p.status().as_str_name(),"revision":p.revision,"withdrawn_by":p.withdrawn_by,"withdrawn_at_ms":p.withdrawn_at_ms})
}
fn consumption(c: &ArtifactConsumptionApproval) -> Value {
    json!({"consumption_id":c.consumption_id,"publication_id":c.publication_id,"objective_id":c.objective_id,"approved_by":c.approved_by,"approved_at_ms":c.approved_at_ms,"status":c.status().as_str_name(),"revision":c.revision,"withdrawn_by":c.withdrawn_by,"withdrawn_at_ms":c.withdrawn_at_ms})
}

// Options for `supertag get artifact-publications` and `supertag get artifact-consumptions`: the
// publications approved from an Objective, or the consumption approvals for a destination one.
#[derive(Args)]
pub struct ListArgs {
    /// Objective whose approvals to list.
    #[arg(long, required_unless_present = "id", conflicts_with = "id")]
    objective: Option<String>,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 30, conflicts_with = "id")]
    limit: u32,
    /// Continue from the next_before_order the previous page returned.
    #[arg(long, default_value_t = 0, conflicts_with = "id")]
    before_order: u64,
}

impl ListArgs {
    fn request(self) -> ListObjectiveArtifactApprovalsRequest {
        ListObjectiveArtifactApprovalsRequest {
            objective_id: self.objective.unwrap_or_default(),
            limit: self.limit,
            before_order: self.before_order,
        }
    }
}

fn client(
    channel: ProtocolChannel,
) -> artifact_publications_client::ArtifactPublicationsClient<ProtocolChannel> {
    artifact_publications_client::ArtifactPublicationsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch_publication(
    channel: ProtocolChannel,
    token: &str,
    approval_id: String,
) -> Result<Value> {
    Ok(publication(
        &client(channel)
            .get_publication(request(GetArtifactApprovalRequest { approval_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn fetch_consumption(
    channel: ProtocolChannel,
    token: &str,
    approval_id: String,
) -> Result<Value> {
    Ok(consumption(
        &client(channel)
            .get_consumption(request(GetArtifactApprovalRequest { approval_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list_publications(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let list = client(channel)
        .list_publications(request(args.request(), &token)?)
        .await?
        .into_inner();
    Ok(
        json!({"publications":list.publications.iter().map(|p|json!({"publication_id":p.publication_id,"source_objective_id":p.source_objective_id,"artifact_id":p.artifact_id,"files":files(&p.files),"status":p.status().as_str_name(),"revision":p.revision,"supersedes_publication_id":p.supersedes_publication_id})).collect::<Vec<_>>(),"next_before_order":list.next_before_order}),
    )
}

pub(crate) async fn list_consumptions(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let list = client(channel)
        .list_consumptions(request(args.request(), &token)?)
        .await?
        .into_inner();
    Ok(
        json!({"consumptions":list.consumptions.iter().map(consumption).collect::<Vec<_>>(),"next_before_order":list.next_before_order}),
    )
}

pub async fn run(connection: Connection, command: PublicationCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let value = match command {
        PublicationCommand::Publish {
            publication_id,
            artifact_id,
            path,
            audience,
            supersedes,
        } => publication(
            &client
                .publish(request(
                    PublishArtifactRequest {
                        publication_id,
                        artifact_id,
                        paths: path,
                        audience_objective_ids: audience,
                        supersedes_publication_id: supersedes,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        PublicationCommand::Consume {
            consumption_id,
            publication_id,
            objective_id,
        } => consumption(
            &client
                .consume(request(
                    ConsumeArtifactPublicationRequest {
                        consumption_id,
                        publication_id,
                        objective_id,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        PublicationCommand::Withdraw {
            publication_id,
            expected_revision,
        } => publication(
            &client
                .withdraw_publication(request(
                    WithdrawArtifactApprovalRequest {
                        approval_id: publication_id,
                        expected_revision,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        PublicationCommand::WithdrawConsumption {
            consumption_id,
            expected_revision,
        } => consumption(
            &client
                .withdraw_consumption(request(
                    WithdrawArtifactApprovalRequest {
                        approval_id: consumption_id,
                        expected_revision,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        PublicationCommand::Audit {
            approval_type,
            approval_id,
        } => {
            let list = client
                .list_audit(request(
                    ListArtifactApprovalAuditRequest {
                        approval_type,
                        approval_id,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({"events":list.events.iter().map(|e|json!({"approval_type":e.approval_type,"approval_id":e.approval_id,"objective_id":e.objective_id,"revision":e.revision,"action":e.action,"actor":e.actor,"recorded_at_ms":e.recorded_at_ms})).collect::<Vec<_>>()})
        }
    };
    crate::terminal::print_json(&value)?;
    Ok(())
}
