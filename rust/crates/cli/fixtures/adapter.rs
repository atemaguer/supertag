use std::{io::Read, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAttachRequest, HarnessCompleteRequest, HarnessPublishRequest,
        harness_client::HarnessClient,
    },
};

#[tokio::main]
async fn main() -> Result<()> {
    let mut bootstrap = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut bootstrap)?;
    ensure!(
        bootstrap.len() <= 4096,
        "bootstrap exceeds the fixture limit"
    );
    let bootstrap = AdapterBootstrap::decode(bootstrap.as_slice())?;
    let mut harness = HarnessClient::connect(bootstrap.endpoint).await?;
    let run = harness
        .attach(authenticated_request(
            HarnessAttachRequest {},
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    let task = run.task.context("fixture received no Task")?;
    harness
        .publish(authenticated_request(
            HarnessPublishRequest {
                sequence: 1,
                text: format!("{} started", run.attempt_id),
            },
            &bootstrap.token,
            None,
        )?)
        .await?;

    if std::env::args().any(|arg| arg == "--wait-for-cancel") {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }

    let result = format!(
        "{}: {} [{}]",
        task.instructions,
        task.prompt,
        task.allowed_actions.join(",")
    );
    harness
        .publish(authenticated_request(
            HarnessPublishRequest {
                sequence: 2,
                text: result.clone(),
            },
            &bootstrap.token,
            None,
        )?)
        .await?;
    harness
        .complete(authenticated_request(
            HarnessCompleteRequest {
                result,
                succeeded: true,
            },
            &bootstrap.token,
            None,
        )?)
        .await?;
    Ok(())
}
