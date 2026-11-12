use std::{process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use tokio::{net::TcpListener, process::Command, time::timeout};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;
use tonic_health::ServingStatus;

#[tokio::test]
async fn health_command_requires_the_requested_grpc_service_to_be_serving() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let (reporter, service) = tonic_health::server::health_reporter();
    reporter
        .set_service_status("fixture.ready", ServingStatus::Serving)
        .await;
    reporter
        .set_service_status("fixture.stopped", ServingStatus::NotServing)
        .await;
    let shutdown = tokio_util::sync::CancellationToken::new();
    let stopped = shutdown.clone();
    let server = tokio::spawn(async move {
        Server::builder()
            .add_service(service)
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), stopped.cancelled())
            .await
    });
    let result = async {
        for (name, success, evidence) in [
            ("fixture.ready", true, "SERVING"),
            ("fixture.stopped", false, "NOT_SERVING"),
            ("fixture.missing", false, "service not registered"),
        ] {
            let output = timeout(
                Duration::from_secs(10),
                Command::new(env!("CARGO_BIN_EXE_supertag"))
                    .args([
                        "health",
                        "--endpoint",
                        &endpoint,
                        "--service",
                        name,
                        "--timeout-seconds",
                        "2",
                    ])
                    .env_clear()
                    .stdin(Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await??;
            ensure!(
                output.status.success() == success,
                "health status for {name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let text = if success {
                &output.stdout
            } else {
                &output.stderr
            };
            ensure!(
                String::from_utf8_lossy(text).contains(evidence),
                "missing status evidence for {name}: {}",
                String::from_utf8_lossy(text)
            );
            if success {
                let value: serde_json::Value = serde_json::from_slice(text)?;
                ensure!(value["service"] == name && value["status"] == "SERVING");
            }
        }
        let output = timeout(
            Duration::from_secs(10),
            Command::new(env!("CARGO_BIN_EXE_supertag"))
                .args(["health", "--endpoint", "http://192.0.2.1:3434"])
                .env_clear()
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        ensure!(!output.status.success());
        ensure!(
            String::from_utf8_lossy(&output.stderr)
                .contains("cleartext endpoint must use a loopback")
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    shutdown.cancel();
    timeout(Duration::from_secs(5), server)
        .await
        .context("health fixture did not stop")???;
    result
}

#[tokio::test]
async fn health_command_bounds_a_peer_that_never_answers() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let shutdown = tokio_util::sync::CancellationToken::new();
    let stopped = shutdown.clone();
    let peer = tokio::spawn(async move {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                stopped.cancelled().await;
                drop(stream);
            }
            () = stopped.cancelled() => {}
        }
        Ok::<_, std::io::Error>(())
    });
    let result = timeout(
        Duration::from_secs(10),
        Command::new(env!("CARGO_BIN_EXE_supertag"))
            .args(["health", "--endpoint", &endpoint, "--timeout-seconds", "1"])
            .env_clear()
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    shutdown.cancel();
    timeout(Duration::from_secs(5), peer).await???;
    let output = result??;
    ensure!(!output.status.success());
    ensure!(
        String::from_utf8_lossy(&output.stderr).contains("gRPC health check timed out"),
        "unexpected stalled-peer outcome: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
