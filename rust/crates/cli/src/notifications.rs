//! `supertag test notification`: send a harmless sample through every destination the Gateway
//! is configured to notify. TypeScript parity: `apps/cli/src/notification-command.ts`. The
//! Gateway that delivers operator notifications sends the sample, so the command checks the
//! same settings and senders the outbox uses, including a remote Gateway's.
use anyhow::Result;
use clap::Subcommand;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        NotificationProvider, SendTestNotificationRequest, SendTestNotificationResponse,
        operator_notification_test_client::OperatorNotificationTestClient,
    },
};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum TestCommand {
    /// Send a sample notification through every configured destination.
    Notification {
        #[command(flatten)]
        connection: Connection,
        /// Link the sample to this Objective.
        #[arg(long, default_value = "")]
        objective: String,
    },
}

pub async fn run(command: TestCommand) -> Result<()> {
    let TestCommand::Notification {
        connection,
        objective,
    } = command;
    let (channel, token) = connect_operator(connection).await?;
    let response = OperatorNotificationTestClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
        .send_test_notification(request(
            SendTestNotificationRequest {
                objective_id: objective.trim().to_owned(),
            },
            &token,
        )?)
        .await?
        .into_inner();
    print!("{}", render(&response));
    Ok(())
}

fn render(response: &SendTestNotificationResponse) -> String {
    if response.results.is_empty() {
        return "Notification: not configured\n".into();
    }
    let mut out = String::new();
    for result in &response.results {
        let provider = match result.provider() {
            NotificationProvider::Slack => "slack",
            NotificationProvider::Webhook => "webhook",
            NotificationProvider::Desktop => "desktop",
            NotificationProvider::Unspecified => "unknown",
        };
        let line = if result.delivered {
            format!("{provider}: delivered")
        } else if result.provider() == NotificationProvider::Desktop
            && result.error.contains("unavailable")
        {
            "desktop: unavailable".into()
        } else {
            let error = if result.error.is_empty() {
                "delivery failed"
            } else {
                &result.error
            };
            format!("{provider}: failed: {error}")
        };
        out.push_str(&line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::TestNotificationResult;

    #[test]
    fn output_matches_the_typescript_command() {
        assert_eq!(
            render(&SendTestNotificationResponse::default()),
            "Notification: not configured\n"
        );
        let result =
            |provider: NotificationProvider, delivered, error: &str| TestNotificationResult {
                provider: provider as i32,
                delivered,
                error: error.into(),
            };
        assert_eq!(
            render(&SendTestNotificationResponse {
                results: vec![
                    result(NotificationProvider::Slack, true, ""),
                    result(
                        NotificationProvider::Desktop,
                        false,
                        "Desktop notification unavailable"
                    ),
                    result(
                        NotificationProvider::Webhook,
                        false,
                        "Webhook returned HTTP 500"
                    ),
                ],
            }),
            "slack: delivered\ndesktop: unavailable\nwebhook: failed: Webhook returned HTTP 500\n"
        );
    }
}
