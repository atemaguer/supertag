use std::{net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use supertag_shared_execution::{Config, Provider};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::{Identity, Server, ServerTlsConfig};

#[derive(Parser)]
#[command(
    about = "Serve one shared execution root over gRPC",
    long_about = "Serve one shared execution root over gRPC. Set SUPERTAG_EXECUTION_ADMIN_TOKEN in the service environment. File operations use paths relative to the fixed root. Linux process mode requires a separate non-root workload identity and trusts workloads that share the root."
)]
struct Arguments {
    /// Bind address. TLS is required outside loopback.
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
    #[arg(long)]
    environment_id: String,
    /// Existing directory shared by the authorized accesses.
    #[arg(long)]
    root: PathBuf,
    /// Owner-only directory outside the root for the journal and cleanup receipts.
    #[arg(long)]
    state_directory: PathBuf,
    /// Linux workload UID. A root service drops to this identity before execution.
    #[arg(long, requires = "process_gid")]
    process_uid: Option<u32>,
    #[arg(long, requires = "process_uid")]
    process_gid: Option<u32>,
    #[arg(long, requires = "tls_key")]
    tls_cert: Option<PathBuf>,
    #[arg(long, requires = "tls_cert")]
    tls_key: Option<PathBuf>,
}

fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() == Some(std::ffi::OsStr::new("__shared-execution-guardian"))
        && arguments.next().is_none()
    {
        // Guardian stdout and stderr carry workload bytes only.
        if supertag_shared_execution::run_guardian().is_err() {
            std::process::exit(1);
        }
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}

async fn serve() -> Result<()> {
    let args = Arguments::parse();
    ensure!(
        args.listen.ip().is_loopback() || args.tls_cert.is_some(),
        "non-loopback shared execution requires TLS"
    );
    let admin_token = std::env::var("SUPERTAG_EXECUTION_ADMIN_TOKEN")
        .context("set SUPERTAG_EXECUTION_ADMIN_TOKEN")?;
    let provider = Provider::open(Config {
        environment_id: args.environment_id,
        root: args.root,
        state_directory: args.state_directory,
        admin_token,
        process_identity: args.process_uid.zip(args.process_gid),
    })
    .await?;
    let mut server = Server::builder()
        .concurrency_limit_per_connection(32)
        .max_concurrent_streams(32);
    if let Some((cert, key)) = args.tls_cert.zip(args.tls_key) {
        server = server.tls_config(ServerTlsConfig::new().identity(Identity::from_pem(
            tokio::fs::read(cert).await?,
            tokio::fs::read(key).await?,
        )))?;
    }
    let listener = TcpListener::bind(args.listen).await?;
    println!("{}", listener.local_addr()?);
    let stopping = provider.clone();
    server
        .add_service(provider.service())
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async move {
            termination().await;
            stopping.shutdown().await;
        })
        .await?;
    provider.shutdown().await;
    Ok(())
}

async fn termination() {
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    } else {
        let _ = tokio::signal::ctrl_c().await;
    }
}
