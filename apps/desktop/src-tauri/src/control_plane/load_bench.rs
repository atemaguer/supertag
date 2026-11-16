//! Measures how long opening a long conversation takes through the desktop's native client,
//! directly and through a proxy that adds network latency like a remote Control Plane's.
//!
//! `cargo test --release --lib load_bench -- --ignored --nocapture`. `SUPERTAG_BENCH_TURNS`,
//! `SUPERTAG_BENCH_EVENTS` and `SUPERTAG_BENCH_RTT_MS` change the conversation and the latency.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use sha2::Digest as _;
use supertag_control_plane::{HostAuthority, Store};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
};

use super::*;

const PRINCIPAL: &str = "operator:desktop-test";

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Forwards each connection to `upstream`, holding every chunk for `delay` in each direction.
async fn delay_proxy(upstream: String, delay: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (client, _) = listener.accept().await.unwrap();
            let server = TcpStream::connect(&upstream).await.unwrap();
            client.set_nodelay(true).unwrap();
            server.set_nodelay(true).unwrap();
            let (client_read, client_write) = client.into_split();
            let (server_read, server_write) = server.into_split();
            tokio::spawn(pipe(client_read, server_write, delay));
            tokio::spawn(pipe(server_read, client_write, delay));
        }
    });
    address
}

async fn pipe(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    delay: Duration,
) {
    let (sender, mut receiver) = mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    tokio::spawn(async move {
        while let Some((due, bytes)) = receiver.recv().await {
            tokio::time::sleep_until(due.into()).await;
            if to.write_all(&bytes).await.is_err() {
                return;
            }
        }
    });
    let mut buffer = vec![0; 64 * 1024];
    while let Ok(read) = from.read(&mut buffer).await {
        if read == 0
            || sender
                .send((Instant::now() + delay, buffer[..read].to_vec()))
                .is_err()
        {
            return;
        }
    }
}

/// A conversation of `turns` finished turns, each with `events` events: mostly activity lines,
/// a plan, and two messages the Tag wrote.
async fn seed(database: &std::path::Path, turns: u64, events: u64) {
    let store = Store::open(&format!("sqlite://{}?mode=rwc", database.display()))
        .await
        .unwrap();
    store
        .seed_host("bench-host", &sha2::Sha256::digest(b"bench-host"))
        .await
        .unwrap();
    let record = store
        .register_host("bench-host", "bench-incarnation")
        .await
        .unwrap();
    let host = HostAuthority::new("host:bench-host", record.generation).unwrap();
    for turn in 0..turns {
        let message = store
            .send_message(
                PRINCIPAL,
                &v2::SendMessageRequest {
                    tag_id: "engineer".into(),
                    text: format!("Turn {turn}: look at the failing build and fix it."),
                    operation_id: format!("bench-{turn}"),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let task_id = message.task.unwrap().task_id;
        let assignment = store
            .claim_task_for_host(
                &host,
                &format!("bench-claim-{turn}"),
                &[],
                v2::HarnessKind::Codex,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(assignment.task.as_ref().unwrap().task_id, task_id);
        store
            .start_task(
                &host,
                &v2::StartTaskRequest {
                    task_id: task_id.clone(),
                    attempt_id: assignment.attempt_id.clone(),
                    lease_token: assignment.lease_token.clone(),
                },
            )
            .await
            .unwrap();
        for sequence in 1..=events {
            let (kind, text) = if sequence == 1 || sequence == events / 2 {
                (
                    v2::TaskEventKind::Message,
                    format!(
                        "I'm going to look at step {sequence} of the build next. {}",
                        "Context. ".repeat(20)
                    ),
                )
            } else if sequence == 2 {
                (
                    v2::TaskEventKind::Progress,
                    r#"{"type":"progress.updated","progress":{"summary":"Fix the build","items":[{"text":"Read the log","status":"active"}]}}"#.into(),
                )
            } else {
                (
                    v2::TaskEventKind::Activity,
                    format!("Ran cargo test --workspace -p crate-{sequence}"),
                )
            };
            store
                .append_event(
                    &host,
                    &v2::AppendEventRequest {
                        task_id: task_id.clone(),
                        attempt_id: assignment.attempt_id.clone(),
                        lease_token: assignment.lease_token.clone(),
                        sequence,
                        text,
                        kind: kind as i32,
                    },
                )
                .await
                .unwrap();
        }
        store
            .finish_task(
                &host,
                &v2::FinishTaskRequest {
                    task_id,
                    attempt_id: assignment.attempt_id,
                    lease_token: assignment.lease_token,
                    result: format!("Fixed the build. {}", "Details of the fix. ".repeat(30)),
                    succeeded: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    store.close().await;
}

/// What the desktop does to open a conversation: read its newest page, which carries each turn's
/// events, and read all of a turn's events only where the page left some out.
async fn open(client: &Arc<ControlPlaneState>, id: &str) -> (Duration, usize, usize) {
    let started = Instant::now();
    let page = client
        .messages(
            id,
            ReadMessages {
                tag_id: "engineer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut calls = 1;
    let mut reads = tokio::task::JoinSet::new();
    for message in page
        .messages
        .iter()
        .filter(|message| message.events_truncated)
    {
        let client = client.clone();
        let id = id.to_owned();
        let task = message.task.task_id.clone();
        calls += 1;
        reads.spawn(async move { client.events(&id, task, 0).await.unwrap().len() });
    }
    while let Some(read) = reads.join_next().await {
        read.unwrap();
    }
    (started.elapsed(), calls, page.messages.len())
}

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort();
    values[values.len() / 2]
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark; run it on demand with --ignored --nocapture"]
async fn conversation_open_latency() {
    let turns = env("SUPERTAG_BENCH_TURNS", 60);
    let events = env("SUPERTAG_BENCH_EVENTS", 40);
    let rtt = Duration::from_millis(env("SUPERTAG_BENCH_RTT_MS", 80));
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.sqlite");
    let (address, control_plane_task, cp_task) =
        super::tests::control_plane_fixture(&database, "engineer", "operator-test-token", false)
            .await;
    seed(&database, turns, events).await;

    // Server time per RPC, without the network.
    let store = Store::open(&format!("sqlite://{}?mode=rwc", database.display()))
        .await
        .unwrap();
    let mut list = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        store
            .list_messages(
                PRINCIPAL,
                &v2::ListMessagesRequest {
                    tag_id: "engineer".into(),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        list.push(started.elapsed());
    }
    println!("server ListMessages(50): median {:?}", median(list));
    store.close().await;

    let remote = delay_proxy(address.trim_start_matches("http://").to_owned(), rtt / 2).await;
    for (label, origin) in [("local", address.clone()), ("remote", remote)] {
        let client = Arc::new(ControlPlaneState::default());
        let profiles = directory.path().join(format!("{label}.json"));
        let activation = client
            .save_control_plane(
                &profiles,
                origin,
                label.into(),
                "operator-test-token".into(),
            )
            .await
            .unwrap();
        let id = activation.connection_id().to_owned();
        open(&client, &id).await;
        let mut samples = Vec::new();
        let mut shape = (0, 0);
        for _ in 0..7 {
            let (elapsed, calls, messages) = open(&client, &id).await;
            samples.push(elapsed);
            shape = (calls, messages);
        }
        println!(
            "{label} (rtt {} ms): open median {:?}, {} RPCs for {} messages of {turns} turns x {events} events",
            if label == "local" { 0 } else { rtt.as_millis() },
            median(samples),
            shape.0,
            shape.1,
        );
    }
    control_plane_task.abort();
    cp_task.abort();
}
