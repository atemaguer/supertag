use anyhow::Result;
use clap::Subcommand;
use serde_json::json;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum PlacementCommand {
    /// Replace the labels a bound Worker Host must carry to run a Tag's Tasks.
    RunsOn {
        tag_id: String,
        /// Required labels. Omit every label to allow any bound host.
        labels: Vec<String>,
    },
    /// Explain which bound Worker Hosts can take a Task, and why others cannot.
    Explain { task_id: String },
}

pub async fn run(connection: Connection, command: PlacementCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = placement_client::PlacementClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        PlacementCommand::RunsOn { tag_id, labels } => {
            let tag = client
                .set_tag_runs_on(request(
                    SetTagRunsOnRequest {
                        tag_id,
                        runs_on: labels,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({ "tag_id": tag.tag_id, "runs_on": tag.runs_on })
        }
        PlacementCommand::Explain { task_id } => {
            let diagnosis = client
                .diagnose_task(request(DiagnoseTaskPlacementRequest { task_id }, &token)?)
                .await?
                .into_inner();
            let state = diagnosis
                .state()
                .as_str_name()
                .trim_start_matches("TASK_STATE_")
                .to_ascii_lowercase();
            json!({
                "task_id": diagnosis.task_id,
                "tag_id": diagnosis.tag_id,
                "state": state,
                "required_labels": diagnosis.required_labels,
                "missing_labels": diagnosis.missing_labels,
                "requirement": diagnosis.requirement,
                "summary": diagnosis.summary,
                "hosts": diagnosis.hosts.into_iter().map(|host| {
                    let phase = host
                        .phase()
                        .as_str_name()
                        .trim_start_matches("HOST_PHASE_")
                        .to_ascii_lowercase();
                    json!({
                        "host_id": host.host_id,
                        "phase": phase,
                        "labels": host.labels,
                        "missing_labels": host.missing_labels,
                        "eligible": host.eligible,
                    })
                }).collect::<Vec<_>>(),
            })
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}
