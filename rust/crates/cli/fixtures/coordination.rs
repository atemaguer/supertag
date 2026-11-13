//! Fixture behaviors for overlap warnings and Worker-managed effect receipts.
use std::{fs::OpenOptions, io::Write, path::PathBuf};

use anyhow::{Result, bail, ensure};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, EffectReceipt, EffectReceiptState, HarnessBeginEffectRequest,
        HarnessCompleteEffectRequest, HarnessFailEffectRequest, HarnessStartWorkSessionRequest,
        Task, harness_effects_client::HarnessEffectsClient,
        harness_work_sessions_client::HarnessWorkSessionsClient,
    },
};
use tonic::{Code, transport::Channel};

/// `--start-parallel-work-sessions`: the root turn starts two Work Sessions of its own Tag.
pub async fn start_parallel(bootstrap: &AdapterBootstrap, task: &Task) -> Result<()> {
    if !std::env::args().any(|arg| arg == "--start-parallel-work-sessions")
        || task.session_id.starts_with("work/")
    {
        return Ok(());
    }
    let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
    for index in 1..=2 {
        work.start(authenticated_request(
            HarnessStartWorkSessionRequest {
                operation_id: format!("parallel-{index}"),
                title: format!("Parallel change {index}"),
                instruction: format!("Change the release notes ({index})"),
                workspace_id: None,
                target_tag_id: None,
            },
            &bootstrap.token,
            None,
        )?)
        .await?;
    }
    Ok(())
}

struct Effects {
    client: HarnessEffectsClient<Channel>,
    token: String,
    provider: PathBuf,
}

impl Effects {
    async fn begin(&mut self, key: &str, arguments: &str) -> Result<EffectReceipt, tonic::Status> {
        let request = authenticated_request(
            HarnessBeginEffectRequest {
                idempotency_key: key.into(),
                operation: "create_ticket".into(),
                arguments_json: arguments.into(),
            },
            &self.token,
            None,
        )
        .map_err(|error| tonic::Status::internal(error.to_string()))?;
        Ok(self.client.begin(request).await?.into_inner())
    }

    async fn complete(
        &mut self,
        key: &str,
        arguments: &str,
        result: &str,
    ) -> Result<EffectReceipt> {
        Ok(self
            .client
            .complete(authenticated_request(
                HarnessCompleteEffectRequest {
                    idempotency_key: key.into(),
                    operation: "create_ticket".into(),
                    arguments_json: arguments.into(),
                    result_json: result.into(),
                },
                &self.token,
                None,
            )?)
            .await?
            .into_inner())
    }

    async fn fail(&mut self, key: &str, arguments: &str, error: &str) -> Result<EffectReceipt> {
        Ok(self
            .client
            .fail(authenticated_request(
                HarnessFailEffectRequest {
                    idempotency_key: key.into(),
                    operation: "create_ticket".into(),
                    arguments_json: arguments.into(),
                    error: error.into(),
                },
                &self.token,
                None,
            )?)
            .await?
            .into_inner())
    }

    /// The external provider: one line per real call.
    fn call_provider(&self, key: &str) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.provider)?;
        writeln!(file, "{key}")?;
        Ok(())
    }

    /// The Worker-managed write path: replay, refuse an in-doubt effect, or call the provider
    /// once and record its result.
    async fn invoke(&mut self, key: &str, arguments: &str, result: &str) -> Result<String> {
        let begun = self.begin(key, arguments).await?;
        match begun.state() {
            EffectReceiptState::Completed => {
                ensure!(begun.replayed, "a completed receipt must be a replay");
                Ok(format!("{key} replayed {}", begun.result_json))
            }
            EffectReceiptState::InDoubt => Ok(format!("{key} in doubt")),
            EffectReceiptState::Acquired => {
                self.call_provider(key)?;
                let completed = self.complete(key, arguments, result).await?;
                ensure!(completed.state() == EffectReceiptState::Completed);
                Ok(format!("{key} created {}", completed.result_json))
            }
            state => bail!("unexpected effect state {state:?}"),
        }
    }
}

/// `--effect-fixture=<provider log>`: the prompt names the phase.
pub async fn effects(bootstrap: &AdapterBootstrap, task: &Task) -> Result<Option<String>> {
    let Some(provider) =
        std::env::args().find_map(|arg| arg.strip_prefix("--effect-fixture=").map(PathBuf::from))
    else {
        return Ok(None);
    };
    let mut effects = Effects {
        client: HarnessEffectsClient::connect(bootstrap.endpoint.clone()).await?,
        token: bootstrap.token.clone(),
        provider,
    };
    let one = r#"{"title":"Release","labels":["a","b"]}"#;
    let one_reordered = r#"{ "labels": ["a","b"], "title": "Release" }"#;
    let mut lines = Vec::new();
    match task.prompt.as_str() {
        "first" => {
            lines.push(
                effects
                    .invoke("ticket/1", one, r#"{"ticket":"T-1"}"#)
                    .await?,
            );
            // Key order does not change the effect; the second call replays.
            lines.push(effects.invoke("ticket/1", one_reordered, "{}").await?);
            let reused = effects
                .begin("ticket/1", r#"{"title":"Other"}"#)
                .await
                .expect_err("a key reused for other arguments");
            ensure!(reused.code() == Code::AlreadyExists, "{reused:?}");
            lines.push("ticket/1 reuse refused".into());
            // The provider commits, then the Attempt ends before recording the receipt.
            let begun = effects.begin("ticket/2", "{}").await?;
            ensure!(begun.state() == EffectReceiptState::Acquired);
            effects.call_provider("ticket/2")?;
            let again = effects.begin("ticket/2", "{}").await?;
            ensure!(again.state() == EffectReceiptState::InDoubt);
            lines.push("ticket/2 left in doubt".into());
        }
        "retry" => {
            lines.push(effects.invoke("ticket/1", one, "{}").await?);
            lines.push(effects.invoke("ticket/2", "{}", "{}").await?);
            // Reconciled with the provider: it did create the ticket.
            let settled = effects
                .complete("ticket/2", "{}", r#"{"ticket":"T-2","reconciled":true}"#)
                .await?;
            ensure!(settled.state() == EffectReceiptState::Completed);
            lines.push(effects.invoke("ticket/2", "{}", "{}").await?);
            // A provider error without effect may be retried.
            let begun = effects.begin("ticket/3", "{}").await?;
            ensure!(begun.state() == EffectReceiptState::Acquired);
            let failed = effects.fail("ticket/3", "{}", "provider rejected").await?;
            ensure!(
                failed.state() == EffectReceiptState::Failed && failed.error == "provider rejected"
            );
            lines.push(
                effects
                    .invoke("ticket/3", "{}", r#"{"ticket":"T-3"}"#)
                    .await?,
            );
        }
        _ => bail!("unknown effect fixture phase"),
    }
    Ok(Some(lines.join("\n")))
}
