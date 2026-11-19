//! `--tag-session-tools`: a Tag reads its other Sessions and its Objectives through its Worker
//! Host. The prompt names the phase; the
//! result is a JSON summary the test checks.
use anyhow::{Context, Result};
use serde_json::{Value, json};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessRun, ListTagObjectivesRequest, ListTagSessionsRequest,
        ReadTagObjectiveRequest, ReadTagSessionRequest, SearchTagSessionsRequest, Task,
        harness_tag_sessions_client::HarnessTagSessionsClient,
    },
};
use tonic::transport::Channel;

fn refusal(status: &tonic::Status) -> Value {
    json!(format!("{:?}", status.code()))
}

async fn read_objective(
    client: &mut HarnessTagSessionsClient<Channel>,
    token: &str,
    id: Option<&str>,
) -> Result<Value> {
    Ok(
        match client
            .read_objective(authenticated_request(
                ReadTagObjectiveRequest {
                    objective_id: id.map(str::to_owned),
                },
                token,
                None,
            )?)
            .await
        {
            Ok(view) => json!(
                view.into_inner()
                    .objective
                    .context("Objective")?
                    .objective_id
            ),
            Err(status) => refusal(&status),
        },
    )
}

pub async fn exercise(
    bootstrap: &AdapterBootstrap,
    run: &HarnessRun,
    task: &Task,
) -> Result<Option<String>> {
    if !std::env::args().any(|arg| arg == "--tag-session-tools") {
        return Ok(None);
    }
    let token = bootstrap.token.as_str();
    let capabilities = run.coordination.clone().unwrap_or_default();
    let mut client = HarnessTagSessionsClient::connect(bootstrap.endpoint.clone()).await?;
    if task.prompt == "recall release" {
        let sessions = client
            .list_sessions(authenticated_request(
                ListTagSessionsRequest::default(),
                token,
                None,
            )?)
            .await?
            .into_inner()
            .sessions;
        let matches = client
            .search_sessions(authenticated_request(
                SearchTagSessionsRequest {
                    query: "release".into(),
                    limit: 5,
                },
                token,
                None,
            )?)
            .await?
            .into_inner()
            .matches;
        let mut read = Vec::new();
        for session in &sessions {
            let page = client
                .read_session(authenticated_request(
                    ReadTagSessionRequest {
                        session_id: session.session_id.clone(),
                        limit: 5,
                        before: None,
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            read.extend(page.entries.into_iter().map(|entry| entry.result));
        }
        let objectives = client
            .list_objectives(authenticated_request(
                ListTagObjectivesRequest::default(),
                token,
                None,
            )?)
            .await?
            .into_inner();
        return Ok(Some(
            json!({
                "mayRead": capabilities.may_read_tag_sessions,
                "portfolio": capabilities.tag_portfolio,
                "sessions": sessions.iter().map(|session| &session.session_id).collect::<Vec<_>>(),
                "firstRequests": sessions.iter().map(|session| &session.first_request).collect::<Vec<_>>(),
                "matches": matches.iter().map(|hit| &hit.result_excerpt).collect::<Vec<_>>(),
                "read": read,
                "objectives": objectives.objectives.iter().map(|objective| &objective.objective_id).collect::<Vec<_>>(),
                "readObjective": read_objective(&mut client, token, None).await?,
            })
            .to_string(),
        ));
    }
    if task.prompt.starts_with("The Objective just started") {
        return Ok(Some(
            json!({
                "mayRead": capabilities.may_read_tag_sessions,
                "readObjective": read_objective(&mut client, token, None).await?,
                "readOther": read_objective(&mut client, token, Some("elsewhere")).await?,
                "portfolio": capabilities.tag_portfolio,
            })
            .to_string(),
        ));
    }
    if task.prompt == "Draft release notes" {
        return Ok(Some("Release notes drafted: v2 adds search".into()));
    }
    Ok(None)
}
