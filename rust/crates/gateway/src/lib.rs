//! Public gRPC ingress for operators and Worker Hosts.

pub mod slack;

use std::{future::Future, sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use subtle::ConstantTimeEq;
use supertag_protocol::v2::{
    AppendEventRequest, CancelTaskRequest, ClaimTaskRequest, ClaimTaskResponse, FinishTaskRequest,
    GetTaskRequest, InspectAttemptRequest, ListEventsRequest, ListEventsResponse, PutTagRequest,
    StartTaskRequest, SubmitTaskRequest, Tag, Task, TaskEvent,
    operator_client::OperatorClient,
    operator_server::{Operator, OperatorServer},
    worker_host_client::WorkerHostClient,
    worker_host_server::{WorkerHost, WorkerHostServer},
};
use tonic::{
    Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    transport::Channel,
};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const AUTHORIZATION: &str = "authorization";
const PRINCIPAL: &str = "x-supertag-principal";
const TIMEOUT: &str = "grpc-timeout";

#[derive(Clone)]
pub struct Gateway {
    control_plane: Channel,
    credentials: Arc<Credentials>,
}

struct Credentials {
    service: MetadataValue<Ascii>,
    operator: Principal,
    worker_host: Principal,
}

struct Principal {
    authorization: MetadataValue<Ascii>,
    identity: MetadataValue<Ascii>,
}

impl Gateway {
    /// Tokens come from the process's private configuration. The principal IDs identify
    /// the operator and Worker Host on whose behalf this Gateway forwards requests.
    pub fn new(
        control_plane: Channel,
        gateway_token: String,
        operator_token: String,
        operator_principal: String,
        host_token: String,
        host_principal: String,
    ) -> anyhow::Result<Self> {
        ensure!(
            gateway_token != operator_token
                && gateway_token != host_token
                && operator_token != host_token,
            "Gateway, operator, and Worker Host tokens must be distinct"
        );
        Ok(Self {
            control_plane,
            credentials: Arc::new(Credentials {
                service: bearer(&gateway_token).context("invalid Gateway service credential")?,
                operator: Principal::new(&operator_token, &operator_principal, "operator:")
                    .context("invalid operator configuration")?,
                worker_host: Principal::new(&host_token, &host_principal, "host:")
                    .context("invalid Worker Host configuration")?,
            }),
        })
    }

    pub fn operator_service(&self) -> OperatorServer<Self> {
        OperatorServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn worker_host_service(&self) -> WorkerHostServer<Self> {
        WorkerHostServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn forward<T, R, F>(
        &self,
        request: Request<T>,
        principal: &Principal,
        call: impl FnOnce(Channel, Request<T>) -> F,
    ) -> Result<Response<R>, Status>
    where
        F: Future<Output = Result<Response<R>, Status>>,
    {
        let (request, timeout) = self.credentials.forwarded(request, principal)?;
        tokio::time::timeout(timeout, call(self.control_plane.clone(), request))
            .await
            .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
    }
}

impl Credentials {
    fn forwarded<T>(
        &self,
        request: Request<T>,
        principal: &Principal,
    ) -> Result<(Request<T>, Duration), Status> {
        let values = request.metadata().get_all(AUTHORIZATION);
        let mut authorizations = values.iter();
        let valid = authorizations.next().is_some_and(|value| {
            bool::from(
                value
                    .as_encoded_bytes()
                    .ct_eq(principal.authorization.as_encoded_bytes()),
            )
        });
        if !valid || authorizations.next().is_some() {
            return Err(Status::unauthenticated("valid bearer credential required"));
        }

        let timeout = client_timeout(&request)?.min(CALL_TIMEOUT);
        if timeout.is_zero() {
            return Err(Status::deadline_exceeded("request deadline elapsed"));
        }

        // Rebuild metadata and extensions. The public caller controls neither the
        // private service credential nor the principal used by the Control Plane.
        let mut upstream = Request::new(request.into_inner());
        upstream
            .metadata_mut()
            .insert(AUTHORIZATION, self.service.clone());
        upstream
            .metadata_mut()
            .insert(PRINCIPAL, principal.identity.clone());
        upstream.set_timeout(timeout);
        Ok((upstream, timeout))
    }
}

impl Principal {
    fn new(token: &str, identity: &str, prefix: &str) -> anyhow::Result<Self> {
        ensure!(
            identity.strip_prefix(prefix).is_some_and(|id| {
                !id.is_empty() && id.len() <= 255 && id.bytes().all(|byte| byte.is_ascii_graphic())
            }),
            "principal has invalid role or identity"
        );
        Ok(Self {
            authorization: bearer(token)?,
            identity: identity.parse().context("invalid principal metadata")?,
        })
    }
}

fn bearer(token: &str) -> anyhow::Result<MetadataValue<Ascii>> {
    let body = token.trim_end_matches('=');
    ensure!(
        !body.is_empty()
            && token.len() <= 512
            && body
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/".contains(&byte)),
        "invalid bearer token format"
    );
    let mut value = format!("Bearer {token}")
        .parse::<MetadataValue<Ascii>>()
        .context("invalid bearer metadata")?;
    value.set_sensitive(true);
    Ok(value)
}

fn client_timeout<T>(request: &Request<T>) -> Result<Duration, Status> {
    let values = request.metadata().get_all(TIMEOUT);
    let mut timeouts = values.iter();
    let Some(value) = timeouts.next() else {
        return Ok(CALL_TIMEOUT);
    };
    let invalid = || Status::invalid_argument("invalid grpc-timeout");
    if timeouts.next().is_some() {
        return Err(invalid());
    }
    let bytes = value.as_encoded_bytes();
    let Some((&unit, digits)) = bytes.split_last() else {
        return Err(invalid());
    };
    if digits.is_empty() || digits.len() > 8 || !digits.iter().all(u8::is_ascii_digit) {
        return Err(invalid());
    }
    let value = digits
        .iter()
        .fold(0_u64, |value, digit| value * 10 + u64::from(digit - b'0'));
    match unit {
        b'H' => Ok(Duration::from_secs(value * 3_600)),
        b'M' => Ok(Duration::from_secs(value * 60)),
        b'S' => Ok(Duration::from_secs(value)),
        b'm' => Ok(Duration::from_millis(value)),
        b'u' => Ok(Duration::from_micros(value)),
        b'n' => Ok(Duration::from_nanos(value)),
        _ => Err(invalid()),
    }
}

fn operator_client(channel: Channel) -> OperatorClient<Channel> {
    OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn worker_host_client(channel: Channel) -> WorkerHostClient<Channel> {
    WorkerHostClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl Operator for Gateway {
    async fn put_tag(&self, request: Request<PutTagRequest>) -> Result<Response<Tag>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).put_tag(request).await },
        )
        .await
    }

    async fn submit_task(
        &self,
        request: Request<SubmitTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).submit_task(request).await },
        )
        .await
    }

    async fn get_task(&self, request: Request<GetTaskRequest>) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).get_task(request).await },
        )
        .await
    }

    async fn list_events(
        &self,
        request: Request<ListEventsRequest>,
    ) -> Result<Response<ListEventsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).list_events(request).await },
        )
        .await
    }

    async fn cancel_task(
        &self,
        request: Request<CancelTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { operator_client(channel).cancel_task(request).await },
        )
        .await
    }
}

#[tonic::async_trait]
impl WorkerHost for Gateway {
    async fn claim_task(
        &self,
        request: Request<ClaimTaskRequest>,
    ) -> Result<Response<ClaimTaskResponse>, Status> {
        self.forward(
            request,
            &self.credentials.worker_host,
            |channel, request| async { worker_host_client(channel).claim_task(request).await },
        )
        .await
    }

    async fn start_task(
        &self,
        request: Request<StartTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.worker_host,
            |channel, request| async { worker_host_client(channel).start_task(request).await },
        )
        .await
    }

    async fn inspect_attempt(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.worker_host,
            |channel, request| async { worker_host_client(channel).inspect_attempt(request).await },
        )
        .await
    }

    async fn append_event(
        &self,
        request: Request<AppendEventRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        self.forward(
            request,
            &self.credentials.worker_host,
            |channel, request| async { worker_host_client(channel).append_event(request).await },
        )
        .await
    }

    async fn finish_task(
        &self,
        request: Request<FinishTaskRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.worker_host,
            |channel, request| async { worker_host_client(channel).finish_task(request).await },
        )
        .await
    }
}

#[cfg(test)]
mod tests;
