use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use supertag_protocol::{
    artifacts::validate_capture_request,
    authenticated_request,
    v2::{
        ArtifactDescription, HarnessCaptureArtifactRequest,
        harness_artifacts_client::HarnessArtifactsClient,
    },
};
use tonic::transport::Channel;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Capture {
    #[serde(rename = "operationId")]
    operation_id: Option<String>,
    title: String,
    kind: String,
    summary: Option<String>,
    paths: Vec<String>,
}

impl Capture {
    fn request(
        &self,
        operation_id: String,
        native_session_id: Option<String>,
    ) -> HarnessCaptureArtifactRequest {
        HarnessCaptureArtifactRequest {
            operation_id: self.operation_id.clone().unwrap_or(operation_id),
            description: Some(ArtifactDescription {
                title: self.title.clone(),
                kind: self.kind.clone(),
                summary: self.summary.clone(),
            }),
            paths: self.paths.clone(),
            native_session_id,
        }
    }

    pub(crate) fn parse(params: &Value) -> Result<Self> {
        ensure!(
            params["namespace"] == "supertag",
            "unregistered artifact tool"
        );
        let input = params
            .get("arguments")
            .context("artifact tool arguments are missing")?;
        let capture: Self =
            serde_json::from_value(input.clone()).context("invalid artifact tool arguments")?;
        validate_capture_request(&capture.request("validation".into(), None))?;
        Ok(capture)
    }

    pub(crate) async fn invoke(
        &self,
        client: &mut HarnessArtifactsClient<Channel>,
        operation_id: String,
        (task_id, attempt_id): (&str, &str),
        thread: Option<&str>,
        token: &str,
        secrets: &[String],
    ) -> Result<Value> {
        let safe = |value: &str| crate::auth::redact(value.to_owned(), secrets);
        if self.operation_id.as_ref().is_some_and(|id| safe(id) != *id)
            || self.paths.iter().any(|path| safe(path) != *path)
        {
            return Ok(crate::coordination::refused());
        }
        let mut input = self.request(
            operation_id,
            thread
                .filter(|value| safe(value) == *value)
                .map(str::to_owned),
        );
        if let Some(description) = input.description.as_mut() {
            description.title = safe(&description.title);
            description.kind = safe(&description.kind);
            description.summary = description.summary.as_deref().map(safe);
        }
        let mut request = authenticated_request(input, token, None)?;
        request.set_timeout(Duration::from_secs(65));
        let Ok(response) = client.capture(request).await else {
            return Ok(crate::coordination::response(
                "Artifact capture could not be confirmed.",
                false,
            ));
        };
        let summary = response
            .into_inner()
            .summary
            .context("missing artifact receipt")?;
        ensure!(
            !summary.artifact_id.is_empty()
                && safe(&summary.artifact_id) == summary.artifact_id
                && summary.producer.as_ref().is_some_and(|producer| {
                    producer.task_id == task_id && producer.attempt_id == attempt_id
                }),
            "artifact receipt does not match this Attempt"
        );
        Ok(crate::coordination::response(
            json!({"artifactId": summary.artifact_id, "fileCount": summary.file_count}).to_string(),
            true,
        ))
    }
}

pub(crate) fn spec() -> Value {
    json!({
        "type": "function",
        "name": "capture_artifact",
        "description": "Save selected workspace files as an immutable artifact for the operator. Reuse operationId to retry the same capture.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operationId": {"type": "string", "minLength": 1, "maxLength": 256},
                "title": {"type": "string", "minLength": 1, "maxLength": 200},
                "kind": {"type": "string", "minLength": 1, "maxLength": 64},
                "summary": {"type": "string", "maxLength": 4096},
                "paths": {"type": "array", "minItems": 1, "maxItems": 100,
                          "items": {"type": "string", "minLength": 1, "maxLength": 1024}}
            },
            "required": ["title", "kind", "paths"],
            "additionalProperties": false
        }
    })
}
