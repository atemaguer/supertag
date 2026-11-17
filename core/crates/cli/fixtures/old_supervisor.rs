//! A stand-in for a supervisor from an earlier release, as an upgrade finds it: it holds the
//! state directory's lock, records itself in `supervisor.json` as that release did, and serves a
//! Control Plane that speaks only an older protocol, so this CLI cannot drain through it.
//!
//! ```text
//! supertag-old-supervisor STATE_DIRECTORY STATUS_TEMPLATE PROTOCOL
//! ```
//!
//! `STATUS_TEMPLATE` is a `supervisor.json` whose `pid`, `endpoint` and `started_at_ms` are
//! replaced. It prints `ready` once recorded. On SIGTERM it writes `old-supervisor-stopped`,
//! removes what it recorded, releases the lock and exits, as a supervisor stops its services.
use std::{
    fs::{self, OpenOptions},
    io::Write as _,
    os::unix::fs::OpenOptionsExt as _,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde_json::Value;
use supertag_protocol::{negotiation::Negotiator, v2::ServiceRole};
use tokio::signal::unix::{SignalKind, signal};

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let _ = fs::remove_file(path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("write {}", path.display()))?;
    file.write_all(bytes)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, state, template, protocol] = args.as_slice() else {
        anyhow::bail!("usage: supertag-old-supervisor STATE_DIRECTORY STATUS_TEMPLATE PROTOCOL");
    };
    let state = Path::new(state);
    let protocol: u32 = protocol.parse()?;
    let versions: &'static [u32] = Box::leak(vec![protocol].into_boxed_slice());
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(state.join(".lock"))?;
    lock.try_lock().context("state directory is in use")?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let server = tonic::transport::Server::builder()
        .add_service(
            Negotiator::new(
                ServiceRole::ControlPlane,
                &[
                    ServiceRole::Client,
                    ServiceRole::Gateway,
                    ServiceRole::WorkerHost,
                ],
            )
            .with_versions(versions)
            .service(),
        )
        .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener));
    let server = tokio::spawn(server);

    let mut status: Value = serde_json::from_str(&fs::read_to_string(template)?)?;
    status["pid"] = std::process::id().into();
    status["endpoint"] = endpoint.clone().into();
    status["started_at_ms"] =
        (SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64).into();
    write_private(&state.join("endpoint"), format!("{endpoint}\n").as_bytes())?;
    write_private(
        &state.join("supervisor.json"),
        &serde_json::to_vec_pretty(&status)?,
    )?;
    println!("ready");

    signal(SignalKind::terminate())?.recv().await;
    server.abort();
    write_private(&state.join("old-supervisor-stopped"), b"SIGTERM\n")?;
    let _ = fs::remove_file(state.join("supervisor.json"));
    let _ = fs::remove_file(state.join("endpoint"));
    drop(lock);
    Ok(())
}
