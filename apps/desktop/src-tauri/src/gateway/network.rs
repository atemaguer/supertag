//! A Tag's network log: the requests its Task Attempts' egress proxies allowed and refused, for
//! the Tag details panel. Operators only; the Gateway refuses everyone else.
use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{self, network_logs_client::NetworkLogsClient},
};

use super::{GatewayState, Result, rpc_error};

/// One request a Task Attempt's egress proxy decided.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequest {
    pub at_ms: i64,
    pub method: String,
    pub origin: String,
    pub path: String,
    pub allowed: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub credential: String,
}

/// One Task Attempt's log.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkLog {
    pub task_id: String,
    pub attempt_id: String,
    pub allowed: u64,
    pub denied: u64,
    pub unrecorded: u64,
    pub requests: Vec<NetworkRequest>,
}

impl From<v2::TaskNetworkLog> for NetworkLog {
    fn from(value: v2::TaskNetworkLog) -> Self {
        let log = value.log.unwrap_or_default();
        Self {
            task_id: value.task_id,
            attempt_id: value.attempt_id,
            allowed: log.allowed,
            denied: log.denied,
            unrecorded: log.unrecorded,
            requests: log
                .requests
                .into_iter()
                .map(|record| NetworkRequest {
                    at_ms: record.at_ms,
                    method: record.method,
                    origin: record.origin,
                    path: record.path,
                    allowed: record.allowed,
                    reason: record.reason,
                    status: (record.status != 0).then_some(record.status),
                    credential: record.credential,
                })
                .collect(),
        }
    }
}

impl GatewayState {
    /// The Tag's newest Task Attempts with a network log, newest first.
    pub async fn network_logs(
        &self,
        connection_id: &str,
        tag_id: String,
    ) -> Result<Vec<NetworkLog>> {
        let session = self.session(connection_id).await?;
        let logs = NetworkLogsClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .list(session.request(v2::ListNetworkLogsRequest { tag_id, limit: 20 }))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .logs
            .into_iter()
            .map(NetworkLog::from)
            .collect();
        self.current(&session, logs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_keeps_counts_and_names_only_what_the_proxy_recorded() {
        let log = NetworkLog::from(v2::TaskNetworkLog {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            log: Some(v2::NetworkLog {
                requests: vec![v2::NetworkRequestRecord {
                    at_ms: 5,
                    method: "CONNECT".into(),
                    origin: "https://example.org".into(),
                    allowed: false,
                    reason: "origin is not in the Task's network scope".into(),
                    ..Default::default()
                }],
                allowed: 3,
                denied: 1,
                unrecorded: 0,
            }),
        });
        assert_eq!((log.allowed, log.denied), (3, 1));
        let value = serde_json::to_value(&log).unwrap();
        assert_eq!(value["requests"][0]["origin"], "https://example.org");
        assert!(value["requests"][0].get("status").is_none());
        assert!(value["requests"][0].get("credential").is_none());
    }
}
