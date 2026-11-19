//! The Worklet: register the host once, report its presence, and run a pool of slots, each
//! pinned to one harness. A slot claims an Attempt, starts it, runs it in a Worker process, and
//! carries the outcome the Worker hands over through finalization, delivery, Finish, and cleanup,
//! resuming from its journal entry after a restart.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use prost::Message;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ClaimTaskRequest, FinishTaskRequest, HarnessKind, HostRecord, TaskState,
        worker_host_client::WorkerHostClient,
    },
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tonic::{Code, Status};
use uuid::Uuid;

use crate::local::{
    Assign, AttemptSecrets, Bytes, HostCall, LeaseChange, Milestone, NetworkCredential, Outcome,
    Proto, ResumeCaptures, WorkerState,
};
use crate::worklet::authority::{Authority, with_authority, with_cleanup_authority};
use crate::worklet::claim::{CLAIM_WAIT, claim_request};
use crate::worklet::finish::{
    deliver_reply, ensure_providers_stopped, save_finish, write_session_branch,
};
use crate::worklet::launch::{Launched, launch};
use crate::worklet::pool::{OutcomeKind, Serve, WorkerProcess, serve};
use crate::worklet::recovery::{
    cleanup_terminal, purge_discarded, reclaim, recovery_notice, resolved,
};
use crate::worklet::{HostSigner, HostStorage, background, registration, workers};
use crate::{
    ArtifactSourceConfig, HostHeaders, McpCatalog, RegisteredHost, SharedExecutionConfig,
    WorkerOptions, WorkletOptions, artifact_inputs, environment, failures, lost_ownership,
    provider_environment_for, request, retryable, wait_for_work,
    worker::{adapter, remote},
    worklet::{
        HostToken, checkpoints, cleanup_failure, enrollment,
        journal::{Attempt, Entry, Journal, SLOTS},
        landing, readiness, workspaces,
    },
};

/// How many times a Worker may die before it launched the harness, or before it kept a Finalizing
/// turn's captures, before the Worklet fails the Attempt instead of starting another.
const PRELAUNCH_DEATHS: u32 = 3;

/// The longest a slot waits before it starts another Worker for an Attempt whose Workers keep
/// handing back Retry before launch, for example while its data endpoint is unreachable.
const RETRY_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// How long to wait before the next Worker after `retries` consecutive Retry outcomes: none after
/// the first, then 1 s doubling to [`RETRY_BACKOFF_MAX`].
fn retry_backoff(retries: u32) -> Duration {
    if retries <= 1 {
        return Duration::ZERO;
    }
    Duration::from_secs(1u64 << (retries - 2).min(5)).min(RETRY_BACKOFF_MAX)
}

/// What every slot of the Worklet shares.
struct Worklet {
    options: WorkletOptions,
    /// The host journal: the lock, incarnation, and presence sequence. Slots keep their entries
    /// beside it.
    journal: Arc<Journal>,
    token: String,
    credential: HostToken,
    registration: HostRecord,
    protocol: u32,
    host: RegisteredHost,
    transfers: checkpoints::Transfers,
    storage: HostStorage,
    landings: landing::Landings,
    slots: Arc<readiness::Slots>,
    /// The running Workers, as `supertag ps` lists them.
    workers: workers::Workers,
    keep_awake: Arc<environment::KeepAwake>,
    reported: tokio::sync::watch::Receiver<bool>,
    ready: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    shutdown: CancellationToken,
}

impl Worklet {
    /// Says the host is ready, once.
    fn ready(&self) {
        let ready = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(ready) = ready {
            ready();
        }
    }

    fn worker(&self, harness: usize) -> &WorkerOptions {
        &self.options.harnesses[harness].worker
    }

    /// Waits briefly for the host's first accepted presence report.
    async fn first_report(&self) {
        let mut reported = self.reported.clone();
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            reported.wait_for(|reported| *reported),
        )
        .await;
    }

    fn set(&self, slot: &Slot, state: readiness::State) {
        self.slots.set(&slot.name, slot.harness, state);
        self.keep_awake.update(self.slots.any_busy());
    }
}

/// One slot of the Worker pool: one Attempt of one harness at a time, with its own journal entry
/// and checkouts.
struct Slot {
    name: String,
    harness: usize,
    directory: PathBuf,
    journal: Journal,
    workspaces: workspaces::Workspaces,
    /// Cancelled when a lowered pool size retires this slot: it claims no more work and returns
    /// once it holds no Attempt, leaving its entry empty.
    retire: CancellationToken,
}

/// The name of a harness's slots.
fn harness_name(kind: HarnessKind) -> String {
    match kind {
        HarnessKind::Unspecified => "adapter".into(),
        kind => kind
            .as_str_name()
            .trim_start_matches("HARNESS_KIND_")
            .to_ascii_lowercase()
            .replace('_', "-"),
    }
}

fn slot_name(kind: HarnessKind, number: u32) -> String {
    format!("{}-{number}", harness_name(kind))
}

/// Which configured harness and slot number a slot name names.
fn parse_slot(options: &WorkletOptions, name: &str) -> Option<(usize, u32)> {
    let (prefix, number) = name.rsplit_once('-')?;
    let number = number.parse().ok()?;
    let harness = options
        .harnesses
        .iter()
        .position(|harness| harness_name(harness.worker.harness) == prefix)?;
    Some((harness, number))
}

fn validate(options: &WorkletOptions) -> Result<()> {
    ensure!(
        !options.harnesses.is_empty(),
        "a Worker Host runs at least one harness"
    );
    let mut kinds = std::collections::BTreeSet::new();
    for harness in &options.harnesses {
        let worker = &harness.worker;
        ensure!(
            kinds.insert(harness_name(worker.harness)),
            "a Worker Host runs each harness once"
        );
        remote::validate_time_limit(worker.attempt_timeout, worker.remote_provider.is_some())?;
        ensure!(
            worker.execution_profile.mcp_servers == options.mcp_catalog.capabilities()
                && (worker.execution_profile.mcp_servers.is_empty()
                    || (worker.harness == HarnessKind::ClaudeCode
                        && worker.remote_provider.is_none())),
            "MCP tools require a local Claude Code Worker Host with the matching catalog"
        );
        provider_environment_for(worker.harness, worker.provider_model.as_deref())?;
        ensure!(
            worker.execution_profile.remote_file_workspace == worker.remote_provider.is_some()
                && (worker.remote_provider.is_none()
                    || (matches!(
                        worker.harness,
                        HarnessKind::Cursor
                            | HarnessKind::ClaudeCode
                            | HarnessKind::Opencode
                            | HarnessKind::Codex
                    ) && !options.workspaces.is_empty()
                        && !worker.execution_profile.allow_unsandboxed_commands)),
            "invalid Worker Host remote Workspace profile"
        );
        ensure!(
            worker.execution_profile.shared_execution.as_ref()
                == worker
                    .shared_execution
                    .as_ref()
                    .map(SharedExecutionConfig::capability)
                && (worker.shared_execution.is_none()
                    || (worker.harness == HarnessKind::Cursor
                        && options.workspaces.is_empty()
                        && worker.remote_provider.is_none()
                        && worker.execution_profile.mcp_servers.is_empty()
                        && !worker.execution_profile.allow_unsandboxed_commands)),
            "shared execution requires a Cursor Worker Host with the exact provider profile"
        );
        ensure!(
            !matches!(
                worker.harness,
                HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
            ) || worker.context_catalog.supported_contracts().is_empty(),
            "the selected harness does not load Skills"
        );
    }
    Ok(())
}

/// Moves the slots no configured harness runs out of the way, keeping them for inspection.
/// Their Attempts are fenced when the new incarnation, durable before any slot moves, registers.
fn retire_stranded(options: &WorkletOptions, journal: &Journal) -> Result<()> {
    let stranded = journal
        .occupied_slots()?
        .into_iter()
        .filter(|name| parse_slot(options, name).is_none())
        .collect::<Vec<_>>();
    if stranded.is_empty() {
        return Ok(());
    }
    // A start that stops before it registers still registers the new incarnation next time,
    // when the moved slots are no longer there to tell it to.
    journal.replace_incarnation()?;
    let retired = options
        .state_directory
        .join("retired")
        .join(Uuid::new_v4().simple().to_string());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&retired)?;
    for name in stranded {
        std::fs::rename(
            options.state_directory.join(SLOTS).join(&name),
            retired.join(&name),
        )?;
    }
    Ok(())
}

use std::os::unix::fs::DirBuilderExt as _;

impl Slot {
    fn open(
        options: &WorkletOptions,
        journal: &Journal,
        harness: usize,
        number: u32,
    ) -> Result<Self> {
        let name = slot_name(options.harnesses[harness].worker.harness, number);
        let entry = journal.slot(&name)?;
        let directory = options.state_directory.join(SLOTS).join(&name);
        Ok(Self {
            workspaces: workspaces::Workspaces::new(&directory, options.workspaces.clone())?,
            name,
            harness,
            directory,
            journal: entry,
            retire: CancellationToken::new(),
        })
    }
}

/// Runs this Worker Host's Worklet until `shutdown`, calling `ready` once it can take work.
pub(crate) async fn run(
    mut options: WorkletOptions,
    shutdown: CancellationToken,
    ready: impl FnOnce() + Send + 'static,
) -> Result<()> {
    if let Some(token) = &options.token {
        failures::remember_credential(token);
    }
    validate(&options)?;
    let labels = readiness::host_labels(&options.labels)?;
    let shutdown = shutdown.child_token();
    let journal = Arc::new(Journal::open(&options.state_directory)?);
    let local_roots: Vec<PathBuf> = options
        .workspaces
        .iter()
        .filter_map(workspaces::WorkspaceMapping::local_root)
        .map(Path::to_path_buf)
        .collect();
    let local_roots: Vec<&Path> = local_roots.iter().map(PathBuf::as_path).collect();
    if !options.workspace_mounts.is_empty() {
        ensure!(
            options.harnesses.iter().all(|harness| {
                supertag_protocol::workspace_mounts::mount_harness(harness.worker.harness)
                    && harness.worker.shared_execution.is_none()
            }) && !options.workspaces.is_empty()
                && local_roots.len() == options.workspaces.len(),
            "Workspace copy mounts require a Codex, Claude Code, Cursor, or OpenCode Worker Host with local Workspace mappings"
        );
        let state_directory = options.state_directory.clone();
        let artifact_storage = options
            .artifact_source
            .as_ref()
            .map(|source| source.directory.clone())
            .unwrap_or_else(|| state_directory.join("artifacts"));
        options.workspace_mounts.protect(
            &state_directory,
            &local_roots,
            Some(artifact_storage.as_path()),
        )?;
    }
    retire_stranded(&options, &journal)?;
    // Terminal proof is durable; finishing a slot's local cleanup needs neither the source
    // repository nor a new network registration.
    let mut cleaned = false;
    for name in journal.occupied_slots()? {
        let Some((harness, number)) = parse_slot(&options, &name) else {
            continue;
        };
        let slot = Slot::open(&options, &journal, harness, number)?;
        if !options.once {
            slot.workspaces.purge_all_discarded_in_background();
        }
        if let Some(Entry::Terminal { attempt, prepared }) = slot.journal.load()? {
            let discarded = cleanup_terminal(
                &slot.journal,
                &slot.workspaces,
                &slot.directory,
                &attempt,
                prepared.as_deref(),
            )?;
            purge_discarded(discarded, options.once);
            cleaned = true;
        }
    }
    if options.once && cleaned {
        ready();
        return Ok(());
    }
    let token = match &options.token {
        Some(token) if !token.is_empty() => token.clone(),
        Some(_) => bail!("Worker Host credential is empty"),
        None => enrollment::host_token(&journal, &options.control_plane)?,
    };
    failures::remember_credential(&token);
    let incarnation_id = journal.incarnation()?;
    let channel = options.control_plane.clone().connect_lazy();
    let Some((registration, protocol)) = registration::register(
        &channel,
        &options.control_plane,
        &incarnation_id,
        &token,
        &shutdown,
    )
    .await?
    else {
        return Ok(());
    };
    let headers = HostHeaders::new(registration.generation, protocol);
    let credential = HostToken::new(token.clone());
    // This host holds every artifact and Workspace delivery it produces; the Control Plane relays
    // none of them.
    let serving = options
        .artifact_source
        .take()
        .unwrap_or_else(|| ArtifactSourceConfig::in_state(&options.state_directory))
        .bind(&options.state_directory, &local_roots)
        .await?
        .serve(
            supertag_protocol::v2::artifact_sources_client::ArtifactSourcesClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
            &token,
            &shutdown,
        )
        .await?;
    let signer = HostSigner::Host(credential.clone());
    let storage = registration::host_storage(
        &channel,
        &headers,
        Some(&serving.storage),
        &options.artifact_peers,
        &options.volumes,
        (&options.state_directory.join("review-git"), &signer),
    );
    // Workspace deliveries and Session checkpoints stay in this host's artifact storage; only
    // their digests go upstream.
    let transfers = checkpoints::Transfers::new(channel.clone(), headers.clone(), signer.clone())
        .with_storage(serving.storage.clone())
        .with_checkpoints(checkpoints::Held::new(
            serving.storage.root(),
            &registration.host_id,
        ))
        .with_volumes(Arc::new(options.volumes.clone()));
    // This host lands the Workspace deliveries it holds: right after each one, and queued ones
    // (retries, merges after their Work Session closed) in the background. A `--once` host lands
    // only what it may claim before it exits.
    let landings = landing::Landings::new(
        &options.state_directory,
        channel.clone(),
        headers.clone(),
        &token,
        serving.storage.clone(),
    )?;
    if !options.once {
        landings.spawn(shutdown.clone());
    }
    background::reconcile_checkpoints(&transfers, &shutdown);
    if !options.volumes.is_empty() {
        background::collect_volume_garbage(&options.volumes, &storage.volume_objects, &shutdown);
    }
    let host = WorkerHostClient::with_interceptor(channel, headers)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // Preflight: warn before claiming work when the host is short of disk space.
    if let Some(warning) = environment::low_disk_warning(options.disk_space.sample().as_ref()) {
        supertag_protocol::terminal_text::warn(&warning);
    }
    for harness in &options.harnesses {
        let worker = &harness.worker;
        // A Claude Code lane with sandbox-commands runs its commands in Claude Code's sandbox.
        let sandboxed = worker
            .adapter_args
            .iter()
            .any(|argument| argument == "--sandbox-commands");
        if worker.execution_profile.allow_unsandboxed_commands && !sandboxed {
            let name = match worker.harness {
                HarnessKind::ClaudeCode => "Claude Code",
                HarnessKind::Opencode => "OpenCode",
                HarnessKind::Cursor => "Cursor",
                _ => "This harness",
            };
            supertag_protocol::terminal_text::warn(&adapter::unsandboxed_caveat(name));
        }
        // A sign-in the provider proxy can't hold stays readable to commands run unsandboxed.
        // Claude Code's sandbox keeps commands from the sign-in's files and Keychain.
        if let Some(warning) = adapter::unproxied_key_warning(worker, &harness.provider_credentials)
            .filter(|_| !sandboxed)
        {
            supertag_protocol::terminal_text::warn(&warning);
        }
    }
    let keep_awake = Arc::new(environment::KeepAwake::start(
        options.keep_awake.clone(),
        shutdown.clone(),
    ));
    let slots = Arc::new(readiness::Slots::default());
    let workspace_ids = {
        let workspaces =
            workspaces::Workspaces::new(&options.state_directory, options.workspaces.clone())?;
        workspaces
            .ids()
            .into_iter()
            .chain(workspaces.control_plane_ids())
            .collect()
    };
    let presence = readiness::Presence::start(
        journal.clone(),
        options.disk_space.clone(),
        host.clone(),
        token.clone(),
        (
            options
                .harnesses
                .iter()
                .map(|harness| {
                    let profile = harness.worker.execution_profile.clone();
                    let catalog = options.mcp_catalog.clone();
                    readiness::Harness {
                        kind: harness.worker.harness,
                        profile: Arc::new(move || {
                            McpCatalog::advertised(&profile, &catalog.lapsed_logins())
                        }),
                    }
                })
                .collect(),
            options.concurrency.clone(),
        ),
        (workspace_ids, labels),
        slots.clone(),
        shutdown.clone(),
    );
    let worklet = Arc::new(Worklet {
        journal: journal.clone(),
        token,
        credential,
        registration,
        protocol,
        host,
        transfers,
        storage,
        landings,
        slots: slots.clone(),
        workers: workers::Workers::open(&options.state_directory),
        keep_awake: keep_awake.clone(),
        reported: presence.reported(),
        ready: std::sync::Mutex::new(Some(Box::new(ready))),
        shutdown: shutdown.clone(),
        options,
    });
    let worklet_generation = worklet.registration.generation;
    let outcome = pool(worklet.clone()).await;
    let mut host = worklet.host.clone();
    let token = worklet.token.clone();
    drop(worklet);
    drop(serving);
    if let Ok(keep_awake) = Arc::try_unwrap(keep_awake) {
        keep_awake.stop().await;
    }
    if let Err((error, Some(attempt))) = &outcome
        && error
            .downcast_ref::<cleanup_failure::CleanupUnconfirmed>()
            .is_some()
    {
        cleanup_failure::report(&mut host, attempt, &token, error).await;
    }
    let generation = worklet_generation;
    // A fenced or revoked registration stopped presence, and so the Worklet.
    let stopped = presence.stop().await.with_context(|| {
        format!("Worker Host registration generation {generation} is no longer current")
    });
    // A fenced registration explains whatever its slots then failed with.
    match stopped {
        Err(fenced) => Err(fenced),
        Ok(()) => outcome.map_err(|(error, _)| error),
    }
}

/// A slot's failure, with the Attempt it left unsettled.
type SlotFailure = (anyhow::Error, Option<Attempt>);

/// Runs the pool: one slot per harness per unit of concurrency, plus any slot that still holds an
/// Attempt beyond it. Raising the size starts slots; lowering it retires the highest ones once they
/// hold no Attempt. With `--once`, one slot runs and the Worklet returns after its Attempt.
async fn pool(worklet: Arc<Worklet>) -> Result<(), SlotFailure> {
    let options = &worklet.options;
    let mut concurrency = options.concurrency.clone();
    let mut running: HashMap<String, (CancellationToken, tokio::task::AbortHandle)> =
        HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut resizable = !options.once;
    let occupied: Vec<(usize, u32)> = worklet
        .journal
        .occupied_slots()
        .map_err(|error| (error, None))?
        .iter()
        .filter_map(|name| parse_slot(options, name))
        .collect();
    let wanted = |size: u32| -> Vec<(usize, u32)> {
        let size = if options.once { 1 } else { size.max(1) };
        let mut slots = Vec::new();
        for harness in 0..options.harnesses.len() {
            for number in 0..size {
                if !options.once || harness == 0 {
                    slots.push((harness, number));
                }
            }
        }
        slots
    };
    let start = |tasks: &mut tokio::task::JoinSet<(String, Result<(), SlotFailure>)>,
                 running: &mut HashMap<String, (CancellationToken, tokio::task::AbortHandle)>,
                 (harness, number): (usize, u32)|
     -> Result<(), SlotFailure> {
        let slot = Slot::open(options, &worklet.journal, harness, number)
            .map_err(|error| (error, None))?;
        let (name, retire) = (slot.name.clone(), slot.retire.clone());
        worklet.set(&slot, readiness::State::Pending);
        let worklet = worklet.clone();
        let task = tasks.spawn(async move {
            let name = slot.name.clone();
            let result = failures::per_slot(run_slot(worklet, slot)).await;
            (name, result)
        });
        running.insert(name, (retire, task));
        Ok(())
    };
    let mut size = *concurrency.borrow_and_update();
    let mut initial = wanted(size);
    if !options.once || occupied.is_empty() {
        initial.extend(occupied.iter().copied());
    } else {
        // `--once` resumes what the journal holds before it claims anything new.
        initial = occupied.clone();
    }
    initial.sort_unstable();
    initial.dedup();
    for slot in initial {
        if let Err(failure) = start(&mut tasks, &mut running, slot) {
            // The slots started already drain their Workers rather than being dropped.
            worklet.shutdown.cancel();
            while tasks.join_next().await.is_some() {}
            return Err(failure);
        }
    }
    // A slot beyond the pool size resumes the Attempt it holds, then retires.
    let sized = wanted(size);
    for (name, (retire, _)) in &running {
        if parse_slot(options, name).is_some_and(|slot| !sized.contains(&slot)) {
            retire.cancel();
        }
    }
    loop {
        tokio::select! {
            changed = concurrency.changed(), if resizable => {
                if changed.is_err() {
                    // Nobody can resize the pool any more.
                    resizable = false;
                    continue;
                }
                size = *concurrency.borrow_and_update();
                let wanted = wanted(size);
                for (name, (retire, _)) in &running {
                    if let Some((harness, number)) = parse_slot(options, name)
                        && !wanted.contains(&(harness, number))
                    {
                        retire.cancel();
                    }
                }
                for slot in wanted {
                    let name = slot_name(options.harnesses[slot.0].worker.harness, slot.1);
                    if !running.contains_key(&name)
                        && let Err((error, _)) = start(&mut tasks, &mut running, slot)
                    {
                        // The running slots and their Attempts go on; the next resize tries it
                        // again.
                        failures::note_unrecorded(
                            &format!("Worker pool slot {name} did not start and stays stopped"),
                            &error,
                        );
                        worklet.slots.remove(&name);
                    }
                }
                worklet.slots.notify();
            }
            joined = tasks.join_next() => {
                let Some(joined) = joined else {
                    if worklet.shutdown.is_cancelled() || options.once {
                        return Ok(());
                    }
                    return Err((anyhow::anyhow!("every Worker pool slot stopped"), None));
                };
                let (name, result) = match joined {
                    Ok(joined) => joined,
                    Err(error) if error.is_cancelled() => continue,
                    // A slot that panicked failed as one that returned an error does: its
                    // siblings and their Workers go on.
                    Err(error) => {
                        let Some(name) = running
                            .iter()
                            .find(|(_, (_, task))| task.id() == error.id())
                            .map(|(name, _)| name.clone())
                        else {
                            continue;
                        };
                        (name, Err((anyhow::anyhow!("the slot stopped: {error}"), None)))
                    }
                };
                running.remove(&name);
                match result {
                    Ok(()) if worklet.shutdown.is_cancelled() || options.once => {
                        worklet.slots.remove(&name);
                    }
                    Ok(()) => {
                        // A retired slot left; one the pool size wants again starts afresh.
                        let slot = parse_slot(options, &name);
                        if let Some(slot) = slot.filter(|slot| wanted(size).contains(slot)) {
                            if let Err((error, _)) = start(&mut tasks, &mut running, slot) {
                                failures::note_unrecorded(
                                    &format!("Worker pool slot {name} did not start and stays stopped"),
                                    &error,
                                );
                                worklet.slots.remove(&name);
                            }
                        } else {
                            worklet.slots.remove(&name);
                        }
                    }
                    // One slot's failure is the host's when it is the only slot, as a host with
                    // one harness and one slot always was.
                    Err(failure)
                        if options.once
                            || (options.harnesses.len() == 1 && size == 1 && running.is_empty())
                            || worklet.shutdown.is_cancelled() =>
                    {
                        worklet.shutdown.cancel();
                        while tasks.join_next().await.is_some() {}
                        return Err(failure);
                    }
                    Err((error, attempt)) => {
                        // A slot that failed leaves its siblings and their Attempts running. Its
                        // entry resumes when the slot starts again.
                        failures::note_unrecorded(&format!("Worker pool slot {name} failed"), &error);
                        if let Some(attempt) = &attempt
                            && error
                                .downcast_ref::<cleanup_failure::CleanupUnconfirmed>()
                                .is_some()
                        {
                            cleanup_failure::report(
                                &mut worklet.host.clone(),
                                attempt,
                                &worklet.token,
                                &error,
                            )
                            .await;
                        }
                        // A report now tells a fenced registration from a slot's own failure.
                        worklet.slots.notify();
                        tokio::select! {
                            () = tokio::time::sleep(Duration::from_secs(1)) => {}
                            () = worklet.shutdown.cancelled() => {}
                        }
                        if let Some(slot) = parse_slot(options, &name)
                            && !worklet.shutdown.is_cancelled()
                            && let Err((error, _)) = start(&mut tasks, &mut running, slot)
                        {
                            // The next resize tries it again.
                            failures::note_unrecorded(
                                &format!("Worker pool slot {name} did not restart and stays stopped"),
                                &error,
                            );
                            worklet.slots.remove(&name);
                        }
                    }
                }
            }
        }
    }
}

async fn run_slot(worklet: Arc<Worklet>, slot: Slot) -> Result<(), SlotFailure> {
    let result = Box::pin(slot_loop(&worklet, &slot)).await;
    result.map_err(|error| {
        let attempt = slot
            .journal
            .load()
            .ok()
            .flatten()
            .and_then(|entry| entry.unsettled_attempt().cloned());
        (error, attempt)
    })
}

#[allow(clippy::too_many_lines)]
async fn slot_loop(worklet: &Worklet, slot: &Slot) -> Result<()> {
    let options = &worklet.options;
    let worker = worklet.worker(slot.harness);
    let journal = &slot.journal;
    let workspaces = &slot.workspaces;
    let shutdown = &worklet.shutdown;
    let token = &worklet.token;
    let registration = &worklet.registration;
    let transfers = &worklet.transfers;
    let mut host = worklet.host.clone();
    let mut announced_recovery: Option<String> = None;
    let retire = &slot.retire;
    // How often a Worker of the Attempt now Starting died before it launched the harness.
    let mut deaths: (String, u32) = (String::new(), 0);
    // How many Workers of the Attempt now Starting handed back Retry in a row.
    let mut retries: (String, u32) = (String::new(), 0);
    while !shutdown.is_cancelled() {
        let entry = match journal.load()? {
            Some(entry) => entry,
            // A retired slot leaves before it records a new Claim.
            None if retire.is_cancelled() => {
                worklet.set(slot, readiness::State::Stopping);
                return Ok(());
            }
            None => {
                let operation_id = Uuid::new_v4().to_string();
                let claim = claim_request(options, worker, workspaces, operation_id.clone());
                let entry = Entry::Claim {
                    operation_id,
                    request: claim.encode_to_vec(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        let state = match &entry {
            Entry::Claim { .. } => readiness::State::Ready,
            Entry::Executing { .. } => readiness::State::Recovery,
            _ => readiness::State::Busy,
        };
        worklet.set(slot, state);
        // The turn's reply, which only the Worker's one report carried: made durable here before
        // the Attempt goes on, since an Attempt that cannot finish would otherwise lose it.
        let entry = deliver_reply(&mut host, journal, entry, token, shutdown).await?;
        match entry {
            Entry::Claim {
                operation_id,
                request: saved,
            } => {
                if saved.is_empty() {
                    journal.clear()?;
                    continue;
                }
                let claim = ClaimTaskRequest::decode(saved.as_slice())
                    .context("stored Claim is invalid")?;
                ensure!(
                    claim.operation_id == operation_id,
                    "stored Claim identity differs"
                );
                if claim != claim_request(options, worker, workspaces, operation_id) {
                    // Never submit an unsent Claim with a superseded profile. A
                    // previously allocated reservation expires on its existing lease.
                    journal.clear()?;
                    continue;
                }
                supertag_protocol::crash_point("worker-host.claim", "journaled");
                worklet.first_report().await;
                let mut claim = claim;
                if worklet
                    .ready
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some()
                {
                    // The host says it is ready after its first claim answers, so that one
                    // is not held.
                    claim.wait_ms = 0;
                }
                let mut claim_request = request(claim.clone(), token)?;
                claim_request.set_timeout(CLAIM_WAIT + Duration::from_secs(3));
                let sent = Instant::now();
                // Shutdown ends a held claim; the journaled Claim replays with the same operation
                // on the next start, so an assignment made meanwhile is not lost. Retirement ends
                // it too, and asks again at once with the same operation: an assignment made
                // meanwhile comes back and runs, and otherwise the slot leaves.
                let response = tokio::select! {
                    response = host.claim_task(claim_request) => response,
                    _ = shutdown.cancelled() => continue,
                    _ = retire.cancelled() => {
                        claim.wait_ms = 0;
                        host.claim_task(request(claim, token)?).await
                    }
                };
                let assignment = match response {
                    Ok(response) => response.into_inner().assignment,
                    Err(error) if retryable(&error) => {
                        wait_for_work(shutdown).await;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                worklet.ready();
                if let Some(assignment) = assignment {
                    supertag_protocol::crash_point("worker-host.claim", "assigned");
                    failures::begin_attempt();
                    journal.save(&Entry::Starting {
                        attempt: Attempt::from_assignment(assignment)?,
                    })?;
                    supertag_protocol::crash_point("worker-host.start", "journaled");
                } else {
                    journal.clear()?;
                    if options.once {
                        return Ok(());
                    }
                    // A claim the Control Plane held already waited; claim again at once.
                    if sent.elapsed() >= Duration::from_secs(1) {
                        continue;
                    }
                    tokio::select! {
                        () = wait_for_work(shutdown) => {}
                        () = retire.cancelled() => {}
                    }
                }
            }
            Entry::Starting { attempt } | Entry::PreparingInputs { attempt, .. } => {
                let launched = Box::pin(launch(
                    worker,
                    attempt,
                    workspaces,
                    transfers,
                    shutdown,
                    Authority::new(
                        (&mut host, &worklet.credential),
                        shutdown,
                        (journal, workspaces),
                        (&slot.directory, options.once),
                    ),
                    || worklet.ready(),
                ))
                .await?;
                let Some(launched) = launched else {
                    continue;
                };
                let attempt_id = launched.attempt.attempt_id.clone();
                let end = Box::pin(run_worker(worklet, slot, launched, None)).await?;
                if shutdown.is_cancelled() {
                    return Ok(());
                }
                if end.died() {
                    let starting = matches!(
                        journal.load()?,
                        Some(Entry::Starting { .. } | Entry::PreparingInputs { .. })
                    );
                    supertag_protocol::terminal_text::warn(&format!(
                        "the Worker of Task Attempt {attempt_id} {} before it handed over an outcome",
                        end.describe()
                    ));
                    if starting {
                        if deaths.0 != attempt_id {
                            deaths = (attempt_id.clone(), 0);
                        }
                        deaths.1 += 1;
                        if deaths.1 >= PRELAUNCH_DEATHS
                            && let Some(
                                Entry::Starting { attempt }
                                | Entry::PreparingInputs { attempt, .. },
                            ) = journal.load()?
                        {
                            save_finish(
                                journal,
                                attempt,
                                adapter::failed(
                                    "the Worker stopped before it launched the harness",
                                ),
                            )?;
                        } else {
                            wait_for_work(shutdown).await;
                        }
                    }
                } else if end.outcome == Some(OutcomeKind::Retry) {
                    // A Retry is not a death, so it never fails the Attempt; back off instead, so
                    // an outage that outlasts the Worker's own wait does not start a Worker every
                    // few hundred milliseconds for as long as the lease holds.
                    if retries.0 != attempt_id {
                        retries = (attempt_id.clone(), 0);
                    }
                    retries.1 += 1;
                    let wait = retry_backoff(retries.1);
                    if !wait.is_zero() {
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = shutdown.cancelled() => {}
                        }
                    }
                }
            }
            Entry::Executing { attempt, prepared } => {
                ensure_providers_stopped(worker, journal, &attempt, registration)
                    .await
                    .context(cleanup_failure::CleanupUnconfirmed::default())?;
                // A Worker that just died leaves its guardian stopping the harness's processes.
                wait_for_processes(journal, &attempt, shutdown).await;
                match resolved(&mut host, &attempt, token).await {
                    Ok(true) => journal.save(&Entry::Terminal { attempt, prepared })?,
                    Ok(false) if reclaim(&mut host, journal, &attempt, token).await? => {
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} was interrupted; its processes stopped, so this host recorded it as failed with an unknown outcome",
                            attempt.task_id, attempt.attempt_id
                        ));
                        journal.save(&Entry::Terminal { attempt, prepared })?;
                    }
                    Ok(false) if options.wait_for_recovery => {
                        worklet.ready();
                        // Once per Attempt, however this host came to wait: this slot claims no
                        // work until the operator decides.
                        if announced_recovery.as_deref() != Some(attempt.attempt_id.as_str()) {
                            supertag_protocol::terminal_text::warn(&recovery_notice(&attempt));
                            announced_recovery = Some(attempt.attempt_id.clone());
                        }
                        wait_for_work(shutdown).await;
                    }
                    Ok(false) => {
                        return Err(anyhow::anyhow!(
                            "Task {} Attempt {} needs recovery before this host can claim work",
                            attempt.task_id,
                            attempt.attempt_id
                        )
                        .context(cleanup_failure::CleanupUnconfirmed::default()));
                    }
                    Err(error) if retryable(&error) => wait_for_work(shutdown).await,
                    Err(error) => return Err(error.into()),
                }
            }
            Entry::Finalizing {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                quiet,
                checkpoint,
                workspace,
                remote_tree,
                outputs,
                file_scope,
                failure_detail,
                captured,
                reply_reported,
            } => {
                // This stage is recorded only after the adapter process group was reaped.
                // Exact finalization can safely resume after a Host restart.
                with_cleanup_authority(
                    &mut host,
                    &attempt,
                    token,
                    shutdown,
                    ensure_providers_stopped(worker, journal, &attempt, registration),
                )
                .await?;
                if !captured {
                    let entry = Entry::Finalizing {
                        attempt,
                        result,
                        succeeded,
                        objective_signal,
                        waiting_approval_ids,
                        quiet,
                        checkpoint,
                        workspace,
                        remote_tree,
                        outputs,
                        file_scope,
                        failure_detail,
                        captured: false,
                        reply_reported,
                    };
                    Box::pin(resume_captures(worklet, slot, entry, &mut deaths)).await?;
                    continue;
                }
                // The Worker froze and published a successful turn's outputs, and wrote its
                // Volume copies back, before it handed the outcome over.
                if outputs
                    .as_ref()
                    .is_some_and(|output| succeeded && (!output.frozen || output.pending()))
                {
                    save_finish(
                        journal,
                        attempt,
                        adapter::failed("Task output files could not be captured safely"),
                    )?;
                    continue;
                }
                let cancellation = shutdown.child_token();
                let finalization =
                    with_authority(&mut host, &attempt, token, shutdown, &cancellation, async {
                        let input_state = slot.directory.clone();
                        let input_attempt = attempt.attempt_id.clone();
                        let input_checkout = workspace.checkout.path.clone();
                        tokio::task::spawn_blocking(move || {
                            artifact_inputs::Inputs::cleanup(
                                &input_state,
                                &input_attempt,
                                &input_checkout,
                            )
                        })
                        .await
                        .map_err(|error| {
                            failures::noted(
                                Status::internal("artifact input cleanup failed"),
                                &error,
                            )
                        })?
                        .map_err(|error| {
                            failures::noted(
                                Status::failed_precondition(
                                    "artifact input files could not be removed safely",
                                ),
                                &error,
                            )
                        })?;
                        if let Some(tree) = &remote_tree {
                            workspaces
                                .restore_remote(&workspace, tree, &cancellation)
                                .await
                                .map_err(|error| {
                                    failures::noted(
                                        Status::invalid_argument(
                                            "Remote Workspace output could not be restored safely",
                                        ),
                                        &error,
                                    )
                                })?;
                        }
                        if let Some(directory) = outputs
                            .as_ref()
                            .and_then(|outputs| outputs.cleanup_directory())
                        {
                            let checkout = workspace.checkout.path.clone();
                            let directory = directory.to_owned();
                            tokio::task::spawn_blocking(move || {
                                supertag_workspaces::remove_output_directory(&checkout, &directory)
                                    .map_err(|error| {
                                        failures::noted(
                                            Status::failed_precondition(
                                                "Task output directory could not be removed safely",
                                            ),
                                            &error,
                                        )
                                    })
                            })
                            .await
                            .map_err(|error| {
                                failures::noted(
                                    Status::internal("Task output cleanup failed"),
                                    &error,
                                )
                            })??;
                        }
                        workspaces
                            .finalize(
                                &workspace,
                                &result,
                                (succeeded, file_scope.clone()),
                                outputs.as_ref().map(|output| output.directory.as_str()),
                                &cancellation,
                            )
                            .await
                            .map_err(|error| {
                                // The delivery check names the out-of-scope paths.
                                match error.downcast_ref::<supertag_workspaces::ScopeViolation>() {
                                    Some(violation) => {
                                        Status::permission_denied(violation.to_string())
                                    }
                                    None => Status::invalid_argument(
                                        "Workspace output could not be captured safely",
                                    ),
                                }
                            })
                    })
                    .await;
                match finalization {
                    Ok((pending, _)) => journal.save(&Entry::Finish {
                        attempt,
                        result,
                        succeeded,
                        objective_signal,
                        waiting_approval_ids,
                        quiet,
                        checkpoint,
                        workspace: Some(Box::new(pending)),
                        prepared: Some(workspace),
                        outputs,
                        failure_detail: if succeeded {
                            vec![]
                        } else {
                            failures::merged_detail(failure_detail)
                        },
                        reply_reported,
                    })?,
                    Err(_) if shutdown.is_cancelled() => return Ok(()),
                    Err(error) if retryable(&error) => wait_for_work(shutdown).await,
                    Err(error) if error.code() == Code::PermissionDenied => {
                        save_finish(journal, attempt, adapter::failed(error.message()))?
                    }
                    Err(error) => {
                        failures::note("Workspace output could not be captured safely", &error);
                        save_finish(
                            journal,
                            attempt,
                            adapter::failed("Workspace output could not be captured safely"),
                        )?
                    }
                }
            }
            Entry::Finish {
                attempt,
                result,
                succeeded,
                objective_signal,
                waiting_approval_ids,
                quiet,
                checkpoint,
                workspace,
                prepared,
                outputs,
                failure_detail,
                reply_reported,
            } => {
                with_cleanup_authority(
                    &mut host,
                    &attempt,
                    token,
                    shutdown,
                    ensure_providers_stopped(worker, journal, &attempt, registration),
                )
                .await?;
                let prepared = prepared.or_else(|| {
                    workspace.as_ref().map(|pending| {
                        Box::new(workspaces::PreparedWorkspace {
                            workspace_id: pending.workspace_id.clone(),
                            checkout: pending.checkout.clone(),
                        })
                    })
                });
                if let Some(mut pending) = workspace
                    .as_ref()
                    .filter(|pending| succeeded && !pending.uploaded)
                    .cloned()
                {
                    let receipt = match workspaces.verify(&pending) {
                        Ok(receipt) => receipt,
                        Err(error) => {
                            failures::note(
                                "Workspace output no longer matches its receipt",
                                &error,
                            );
                            save_finish(
                                journal,
                                attempt,
                                adapter::failed("Workspace output no longer matches its receipt"),
                            )?;
                            continue;
                        }
                    };
                    let cancellation = shutdown.child_token();
                    let upload = with_authority(
                        &mut host,
                        &attempt,
                        token,
                        shutdown,
                        &cancellation,
                        async {
                            tokio::select! {
                                result = transfers.upload_workspace(&attempt, &pending, receipt) => result,
                                _ = cancellation.cancelled() => Err(Status::cancelled("workspace transfer cancelled")),
                            }
                        },
                    )
                    .await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                quiet,
                                checkpoint,
                                workspace: Some(pending),
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
                                reply_reported,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(shutdown).await
                        }
                        Err(_) if shutdown.is_cancelled() => return Ok(()),
                        Err(error) => {
                            failures::note("Workspace output could not be committed", &error);
                            save_finish(
                                journal,
                                attempt,
                                adapter::failed("Workspace output could not be committed"),
                            )?
                        }
                    }
                    continue;
                }
                if let Some(mut pending) = checkpoint
                    .as_ref()
                    .filter(|pending| !pending.uploaded)
                    .cloned()
                {
                    let upload =
                        async {
                            // Obtain a fresh budget after the adapter and its descendants stop.
                            host.renew_attempt(request(attempt.inspect(), token).map_err(
                                |_| Status::internal("invalid upload authority request"),
                            )?)
                            .await?;
                            let payload = journal.read_checkpoint(&pending).map_err(|error| {
                                failures::noted(
                                    Status::data_loss("staged checkpoint could not be read"),
                                    &error,
                                )
                            })?;
                            transfers.upload(&attempt, payload).await
                        }
                        .await;
                    match upload {
                        Ok(_) => {
                            pending.uploaded = true;
                            journal.save(&Entry::Finish {
                                attempt,
                                result,
                                succeeded,
                                objective_signal,
                                waiting_approval_ids,
                                quiet,
                                checkpoint: Some(pending),
                                workspace,
                                prepared,
                                outputs,
                                failure_detail: failure_detail.clone(),
                                reply_reported,
                            })?;
                        }
                        Err(error)
                            if retryable(&error) || error.code() == Code::ResourceExhausted =>
                        {
                            wait_for_work(shutdown).await;
                        }
                        Err(error)
                            if lost_ownership(&error)
                                || error.code() == Code::Unauthenticated
                                || error.code() == Code::InvalidArgument
                                || error.code() == Code::DataLoss =>
                        {
                            supertag_protocol::terminal_text::warn(&format!(
                                "Task {} Attempt {}: the Control Plane refused its Session checkpoint ({:?}): {}",
                                attempt.task_id,
                                attempt.attempt_id,
                                error.code(),
                                error.message()
                            ));
                            save_finish(
                                journal,
                                attempt,
                                adapter::failed("Session checkpoint could not be committed"),
                            )?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    continue;
                }
                if outputs
                    .as_ref()
                    .is_some_and(|output| succeeded && output.pending())
                {
                    // Its Worker publishes a turn's outputs before it hands the outcome over.
                    save_finish(
                        journal,
                        attempt,
                        adapter::failed("Task output could not be committed"),
                    )?;
                    continue;
                }
                supertag_protocol::crash_point("worker-host.finish", "journaled");
                // A local Workspace's Session branch goes into its own repository before the
                // Task is reported, so whoever sees it succeed finds the branch. Best effort: the
                // delivery stands either way, and a later delivery writes the branch again.
                if let Some(pending) = workspace.as_ref().filter(|_| succeeded) {
                    write_session_branch(&mut host, workspaces, &attempt, token, pending, shutdown)
                        .await;
                }
                let outcome = host
                    .finish_task(request(
                        FinishTaskRequest {
                            task_id: attempt.task_id.clone(),
                            attempt_id: attempt.attempt_id.clone(),
                            lease_token: attempt.lease_token.clone(),
                            result,
                            succeeded,
                            objective_signal,
                            waiting_approval_ids: waiting_approval_ids.clone(),
                            quiet,
                            artifacts: outputs
                                .as_ref()
                                .filter(|_| succeeded)
                                .and_then(|outputs| outputs.selection())
                                .into_iter()
                                .collect(),
                            checkpoint_sha256: checkpoint.map(|pending| pending.sha256),
                            workspace_delivery: workspace
                                .as_ref()
                                .filter(|_| succeeded)
                                .map(|pending| workspaces.verify(pending))
                                .transpose()?,
                            failure_detail: if succeeded {
                                vec![]
                            } else {
                                failure_detail.clone()
                            },
                        },
                        token,
                    )?)
                    .await;
                match outcome {
                    Ok(response) if response.get_ref().state() == TaskState::Uncertain => {
                        // Cleanup was observed, but the operator still owns the
                        // recovery decision. Preserve the checkout until its receipt.
                        // This host holds an outcome, so it never reclaims the Attempt itself.
                        supertag_protocol::terminal_text::warn(&format!(
                            "Task {} Attempt {} is uncertain: its execution lease lapsed before it finished, so the Control Plane cannot tell what it did (this host recorded it as {})",
                            attempt.task_id,
                            attempt.attempt_id,
                            if succeeded { "succeeded" } else { "failed" },
                        ));
                        journal.processes(&attempt).discard()?;
                        if prepared.is_some() {
                            journal.save(&Entry::Executing { attempt, prepared })?;
                            if options.once {
                                return Ok(());
                            }
                        } else {
                            journal.save(&Entry::Terminal {
                                attempt,
                                prepared: None,
                            })?;
                        }
                        continue;
                    }
                    Ok(response) => {
                        ensure!(
                            matches!(
                                response.get_ref().state(),
                                TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
                            ),
                            "Finish returned a nonterminal Task"
                        );
                        supertag_protocol::crash_point("worker-host.finish", "answered");
                    }
                    Err(error) if retryable(&error) => {
                        wait_for_work(shutdown).await;
                        continue;
                    }
                    Err(error)
                        if error.code() == Code::InvalidArgument
                            && (objective_signal != 0 || !waiting_approval_ids.is_empty()) =>
                    {
                        // An invalid owner signal is rejected before the Finish transaction
                        // commits. Settle the cleaned-up Attempt as a controlled failure.
                        journal.save(&Entry::Finish {
                            attempt,
                            result: "Harness proposed an invalid Objective or approval update"
                                .into(),
                            succeeded: false,
                            objective_signal: 0,
                            waiting_approval_ids: vec![],
                            quiet: false,
                            checkpoint: None,
                            workspace,
                            prepared,
                            outputs: None,
                            failure_detail: vec![],
                            reply_reported: false,
                        })?;
                        continue;
                    }
                    Err(error) if lost_ownership(&error) || error.code() == Code::AlreadyExists => {
                        match resolved(&mut host, &attempt, token).await {
                            Ok(true) => {}
                            Ok(false) => return Err(error.into()),
                            Err(error) if retryable(&error) => {
                                wait_for_work(shutdown).await;
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                journal.save(&Entry::Terminal { attempt, prepared })?;
                supertag_protocol::crash_point("worker-host.terminal", "journaled");
            }
            Entry::Terminal { attempt, prepared } => {
                let discarded = cleanup_terminal(
                    journal,
                    workspaces,
                    &slot.directory,
                    &attempt,
                    prepared.as_deref(),
                )?;
                purge_discarded(discarded, options.once);
                worklet.landings.land_now(shutdown).await;
                worklet.ready();
                if options.once {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// Resumes the captures of a Finalizing turn that its Worker left: a failed turn has none, and a
/// successful one's go to a Worker started for them, which the Attempt's credential is minted
/// for again. The Worklet holds no Attempt credential to make them itself.
async fn resume_captures(
    worklet: &Worklet,
    slot: &Slot,
    entry: Entry,
    deaths: &mut (String, u32),
) -> Result<()> {
    let journal = &slot.journal;
    let shutdown = &worklet.shutdown;
    let Entry::Finalizing {
        attempt,
        succeeded,
        workspace,
        remote_tree,
        outputs,
        ..
    } = &entry
    else {
        bail!("only a Finalizing entry has captures to resume");
    };
    let succeeded = *succeeded;
    let capture_failed = |attempt: &Attempt| {
        save_finish(
            journal,
            attempt.clone(),
            adapter::failed("Task output files could not be captured safely"),
        )
    };
    if !succeeded {
        // A failed turn froze and published nothing.
        let mut entry = entry;
        if let Entry::Finalizing { captured, .. } = &mut entry {
            *captured = true;
        }
        return journal.save(&entry);
    }
    let key = format!("{}/captures", attempt.attempt_id);
    if deaths.0 == key && deaths.1 >= PRELAUNCH_DEATHS {
        return capture_failed(attempt);
    }
    let mut host = worklet.host.clone();
    let mut authority = Authority::new(
        (&mut host, &worklet.credential),
        shutdown,
        (journal, &slot.workspaces),
        (&slot.directory, worklet.options.once),
    );
    // A repeated start mints the Attempt a new credential and ends the last, which no running
    // Worker holds any more.
    let started = match authority.start(attempt).await? {
        Ok(started) => started,
        Err(error) if retryable(&error) => {
            wait_for_work(shutdown).await;
            return Ok(());
        }
        Err(error) => {
            supertag_protocol::terminal_text::warn(&format!(
                "Task {} Attempt {}: its captures could not resume ({:?}): {}",
                attempt.task_id,
                attempt.attempt_id,
                error.code(),
                error.message()
            ));
            return capture_failed(attempt);
        }
    };
    let task = started
        .task
        .context("Control Plane started the Attempt without its Task")?;
    crate::ensure_attempt(&task, attempt)?;
    let mut credentialed = attempt.clone();
    credentialed.attempt_credential = started.attempt_credential;
    if credentialed.attempt_credential.is_empty() {
        return capture_failed(attempt);
    }
    let end = run_worker(
        worklet,
        slot,
        Launched {
            attempt: credentialed,
            task,
            workspace: Some((**workspace).clone()),
            checkpoint: None,
            valid_until: Instant::now(),
        },
        Some(ResumeCaptures {
            remote: remote_tree.is_some(),
            outputs: outputs.clone(),
        }),
    )
    .await?;
    if end.died() && !shutdown.is_cancelled() {
        supertag_protocol::terminal_text::warn(&format!(
            "the Worker resuming the captures of Task Attempt {} {} before it kept them",
            attempt.attempt_id,
            end.describe()
        ));
        if deaths.0 != key {
            *deaths = (key, 0);
        }
        deaths.1 += 1;
        if deaths.1 < PRELAUNCH_DEATHS {
            wait_for_work(shutdown).await;
        }
    }
    Ok(())
}

/// How long recovery waits for an Attempt's recorded processes to stop: its guardian gives the
/// harness a grace period after its Worker dies.
const PROCESS_STOP_WAIT: Duration = Duration::from_secs(10);

/// Waits, briefly, until every process the Attempt recorded is gone.
async fn wait_for_processes(journal: &Journal, attempt: &Attempt, shutdown: &CancellationToken) {
    let processes = journal.processes(attempt);
    let deadline = Instant::now() + PROCESS_STOP_WAIT;
    while processes.recorded() && Instant::now() < deadline && !shutdown.is_cancelled() {
        if processes.stopped().ok().flatten().is_some() {
            return;
        }
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(100)) => {}
            () = shutdown.cancelled() => return,
        }
    }
}

/// Starts a Worker for `launched`, assigns it the Attempt, and serves it until it exits.
async fn run_worker(
    worklet: &Worklet,
    slot: &Slot,
    launched: Launched,
    resume_captures: Option<ResumeCaptures>,
) -> Result<crate::worklet::pool::WorkerEnd> {
    let Launched {
        mut attempt,
        task,
        workspace,
        checkpoint,
        valid_until,
    } = launched;
    let harness = &worklet.options.harnesses[slot.harness];
    // The delivery check applies the started Task's path scope to what the turn changed.
    let file_scope = supertag_protocol::file_scope::of_task(&task)
        .map(supertag_protocol::file_scope::Rules::from);
    // Only the network credentials the Task's scope names reach its Worker.
    let named = supertag_protocol::network_scope::of_task(&task)
        .map(supertag_protocol::network_scope::credentials)
        .unwrap_or_default();
    let network = harness
        .network_credentials
        .iter()
        .filter(|credential| named.contains(credential.name.as_str()))
        .map(|credential| NetworkCredential {
            name: credential.name.clone(),
            variable: credential.variable.clone(),
            value: credential.value().to_owned(),
        })
        .collect();
    let process = WorkerProcess::spawn(&harness.launch, &worklet.token)?;
    worklet.workers.started(workers::RunningWorker {
        pid: process.pid(),
        harness: harness_name(harness.worker.harness),
        slot: slot.name.clone(),
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        tag_id: task.tag_id.clone(),
        state: workers::RunningState::Starting,
        started_at_ms: workers::now_ms(),
    });
    let listed = ListedWorker {
        workers: &worklet.workers,
        slot: &slot.name,
    };
    let assign = Assign {
        slot: slot.name.clone(),
        state_directory: slot.directory.clone(),
        attempt: attempt.clone(),
        task: Proto(task),
        workspace: workspace.clone(),
        checkpoint: checkpoint.map(Proto),
        valid_for_ms: u64::try_from(
            valid_until
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u64::MAX),
        registration: Proto(worklet.registration.clone()),
        protocol: worklet.protocol,
        // This incarnation's registration names it; a new incarnation's applies to the Workers
        // started after it registered.
        data_endpoint: registration::data_endpoint(
            &worklet.registration,
            &worklet.options.control_plane.url(),
        ),
        secrets: AttemptSecrets {
            provider: harness.provider_credentials.clone(),
            network,
            redact: {
                let environment = std::env::vars().collect::<Vec<_>>();
                crate::local::environment_redactions(
                    environment
                        .iter()
                        .map(|(name, value)| (name.as_str(), value.as_str())),
                    worklet.credential.secret(),
                )
            },
        },
        resume_captures,
    };
    // The Attempt credential is the Worker's; the Worklet keeps none of it.
    attempt.attempt_credential.clear();
    let serving = Serving {
        worklet,
        slot,
        attempt,
        workspace,
        file_scope,
    };
    let end = serve(
        process,
        assign,
        &serving,
        &worklet.shutdown,
        crate::worklet::pool::Limits::for_attempt(&harness.worker),
    )
    .await;
    drop(listed);
    Ok(end)
}

/// Takes a Worker off the status file once it is reaped, or when its slot's task is aborted.
struct ListedWorker<'a> {
    workers: &'a workers::Workers,
    slot: &'a str,
}

impl Drop for ListedWorker<'_> {
    fn drop(&mut self) {
        self.workers.ended(self.slot);
    }
}

/// The Worklet's end of one Worker's contract.
struct Serving<'a> {
    worklet: &'a Worklet,
    slot: &'a Slot,
    attempt: Attempt,
    /// The checkout the Worklet assigned: the one every stage the Worker reports names.
    workspace: Option<workspaces::PreparedWorkspace>,
    /// The started Task's path scope, which the delivery check applies.
    file_scope: Option<supertag_protocol::file_scope::Rules>,
}

impl Serving<'_> {
    fn assigned(&self) -> Result<&workspaces::PreparedWorkspace, Status> {
        self.workspace
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("the Attempt was assigned no Workspace"))
    }

    /// The journal entry's stage, which must still be this Attempt's.
    fn current(&self) -> Result<Entry, Status> {
        let entry = self
            .slot
            .journal
            .load()
            .map_err(|error| {
                failures::noted(Status::internal("the journal is unreadable"), &error)
            })?
            .ok_or_else(|| Status::failed_precondition("the slot holds no Attempt"))?;
        match entry.prepared(&self.attempt) {
            Ok(_) => Ok(entry),
            Err(_) => Err(Status::permission_denied(
                "the Worker's Attempt is not the slot's",
            )),
        }
    }

    fn save(&self, entry: &Entry) -> Result<(), Status> {
        self.slot.journal.save(entry).map_err(|error| {
            failures::noted(Status::internal("the journal could not be written"), &error)
        })
    }
}

impl Serve for Serving<'_> {
    fn milestone(&self, milestone: Milestone, group: i32) -> Result<(), Status> {
        let current = self.current()?;
        let starting = matches!(
            current,
            Entry::Starting { .. } | Entry::PreparingInputs { .. }
        );
        let follows = match &milestone {
            Milestone::PreparingInputs | Milestone::Executing => starting,
            Milestone::Finalizing { .. } => matches!(current, Entry::Executing { .. }),
        };
        if !follows {
            return Err(Status::failed_precondition(
                "the milestone does not follow the Attempt's stage",
            ));
        }
        match milestone {
            Milestone::PreparingInputs => self.save(&Entry::PreparingInputs {
                attempt: self.attempt.clone(),
                prepared: Box::new(self.assigned()?.clone()),
            }),
            Milestone::Executing => {
                // The Worker's own process group joins the Attempt's process record: recovery
                // reclaims the Attempt only once it is gone too.
                let processes = self.slot.journal.processes(&self.attempt);
                let recorded = processes
                    .prepare()
                    .and_then(|pending| pending.record(u32::try_from(group).ok()));
                if let Err(error) = recorded {
                    return Err(failures::noted(
                        Status::internal("the Worker's process could not be recorded"),
                        &error,
                    ));
                }
                self.save(&Entry::Executing {
                    attempt: self.attempt.clone(),
                    prepared: self.workspace.clone().map(Box::new),
                })?;
                supertag_protocol::crash_point("worker-host.execute", "journaled");
                self.worklet.set(self.slot, readiness::State::Busy);
                Ok(())
            }
            Milestone::Finalizing {
                completion,
                checkpoint,
                remote_tree,
                outputs,
                failure_detail,
            } => {
                self.save(&Entry::Finalizing {
                    attempt: self.attempt.clone(),
                    result: completion.result,
                    succeeded: completion.succeeded,
                    objective_signal: completion.objective_signal,
                    waiting_approval_ids: completion.waiting_approval_ids,
                    quiet: completion.quiet,
                    checkpoint,
                    workspace: Box::new(self.assigned()?.clone()),
                    remote_tree,
                    outputs,
                    // The Task's own scope, never one the Worker names.
                    file_scope: self.file_scope.clone(),
                    failure_detail,
                    captured: false,
                    reply_reported: false,
                })?;
                supertag_protocol::crash_point("worker-host.finalizing", "journaled");
                Ok(())
            }
        }
    }

    fn outcome(&self, outcome: &Outcome) -> Result<(), Status> {
        let current = self.current()?;
        let executing = matches!(current, Entry::Executing { .. });
        let starting = matches!(
            current,
            Entry::Starting { .. } | Entry::PreparingInputs { .. }
        );
        let capturing = matches!(
            current,
            Entry::Finalizing {
                captured: false,
                ..
            }
        );
        let saved = match outcome {
            // A Worker stopped before it launched anything, or before it kept a Finalizing
            // turn's captures: the entry resumes later.
            Outcome::Retry if starting || capturing => Ok(()),
            Outcome::Retry => Err(Status::failed_precondition(
                "a launched Attempt is not retried",
            )),
            Outcome::Finish {
                completion,
                explained,
                checkpoint,
                failure_detail,
                reply_reported,
            } if starting || executing || capturing => {
                if !explained && !completion.succeeded {
                    supertag_protocol::terminal_text::warn(&format!(
                        "Task {} Attempt {} failed: {}",
                        self.attempt.task_id, self.attempt.attempt_id, completion.result
                    ));
                }
                let prepared = current.prepared(&self.attempt).ok().flatten();
                self.save(&Entry::Finish {
                    attempt: self.attempt.clone(),
                    result: completion.result.clone(),
                    succeeded: completion.succeeded,
                    objective_signal: completion.objective_signal,
                    waiting_approval_ids: completion.waiting_approval_ids.clone(),
                    quiet: completion.quiet,
                    checkpoint: checkpoint.clone(),
                    workspace: None,
                    prepared,
                    outputs: None,
                    failure_detail: if completion.succeeded {
                        vec![]
                    } else {
                        failures::merged_detail(failure_detail.clone())
                    },
                    // A Worker resuming the captures sent no report: the entry knows.
                    reply_reported: *reply_reported || current.reply_is_reported(),
                })
            }
            Outcome::Finalizing {
                outputs: kept,
                reply_reported: acknowledged,
            } if capturing => {
                let mut entry = current;
                if let Entry::Finalizing {
                    outputs,
                    captured,
                    reply_reported,
                    ..
                } = &mut entry
                {
                    outputs.clone_from(kept);
                    *captured = true;
                    *reply_reported |= *acknowledged;
                }
                self.save(&entry)
            }
            _ => Err(Status::failed_precondition(
                "the outcome does not follow the Attempt's stage",
            )),
        };
        if saved.is_ok() && !matches!(outcome, Outcome::Retry) {
            supertag_protocol::crash_point("worker-host.outcome", "journaled");
        }
        saved
    }

    fn state(&self, state: WorkerState) {
        // Starting and finalizing hold the slot as executing does; presence counts all three
        // as busy. `supertag ps` shows which.
        self.worklet.workers.state(&self.slot.name, state);
        self.worklet.set(self.slot, readiness::State::Busy);
    }

    fn call(&self, call: HostCall) -> crate::worklet::pool::HostAnswer {
        let mut host = self.worklet.host.clone();
        let token = self.worklet.token.clone();
        let storage = self.worklet.storage.clone();
        let transfers = self.worklet.transfers.clone();
        Box::pin(async move {
            let encoded = |message: &dyn EncodeMessage| Bytes(message.encode());
            match call {
                HostCall::Renew(Proto(attempt)) => {
                    let result = match request(attempt, &token) {
                        Ok(request) => host
                            .renew_attempt(request)
                            .await
                            .map(tonic::Response::into_inner),
                        Err(error) => {
                            Err(failures::noted(Status::internal("invalid renewal"), &error))
                        }
                    };
                    let change = match &result {
                        Ok(authority) => Some(LeaseChange::Renewed {
                            valid_for_ms: authority.valid_for_ms,
                        }),
                        Err(error) if lost_ownership(error) => Some(LeaseChange::Lost {
                            message: error.message().to_owned(),
                        }),
                        Err(_) => None,
                    };
                    (result.map(|authority| encoded(&authority)), change)
                }
                HostCall::Inspect(Proto(attempt)) => {
                    let result = match request(attempt, &token) {
                        Ok(request) => host
                            .inspect_attempt(request)
                            .await
                            .map(tonic::Response::into_inner),
                        Err(error) => Err(failures::noted(
                            Status::internal("invalid inspection"),
                            &error,
                        )),
                    };
                    (result.map(|task| encoded(&task)), None)
                }
                HostCall::ReportAppliedLimits(Proto(report)) => {
                    let result = match request(report, &token) {
                        Ok(request) => host
                            .report_applied_limits(request)
                            .await
                            .map(tonic::Response::into_inner),
                        Err(error) => {
                            Err(failures::noted(Status::internal("invalid report"), &error))
                        }
                    };
                    (result.map(|response| encoded(&response)), None)
                }
                HostCall::VolumeGrant(Proto(grant)) => (
                    storage
                        .volume_objects
                        .grant(grant)
                        .await
                        .map(|grant| encoded(&grant)),
                    None,
                ),
                HostCall::AuthorizeArtifactTransfer(Proto(authorize)) => (
                    storage
                        .held_transfers
                        .authorize(authorize)
                        .await
                        .map(|authorized| encoded(&authorized)),
                    None,
                ),
                HostCall::ReviewDelivery(Proto(review)) => (
                    transfers
                        .review_delivery(review)
                        .await
                        .map(|held| encoded(&held)),
                    None,
                ),
                HostCall::MintGitAccess(Proto(mint)) => (
                    transfers
                        .mint_git_access(mint)
                        .await
                        .map(|grant| encoded(&grant)),
                    None,
                ),
                HostCall::VerifyOutputRemote(Proto(verify)) => (
                    transfers
                        .verify_output_remote_request(verify)
                        .await
                        .map(|response| encoded(&response)),
                    None,
                ),
            }
        })
    }
}

/// A protobuf message, encoded for a reply.
trait EncodeMessage {
    fn encode(&self) -> Vec<u8>;
}

impl<T: Message> EncodeMessage for T {
    fn encode(&self) -> Vec<u8> {
        self.encode_to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_retries_back_off_to_a_ceiling() {
        assert_eq!(retry_backoff(1), Duration::ZERO);
        assert_eq!(retry_backoff(2), Duration::from_secs(1));
        assert_eq!(retry_backoff(3), Duration::from_secs(2));
        assert_eq!(retry_backoff(6), Duration::from_secs(16));
        assert_eq!(retry_backoff(7), RETRY_BACKOFF_MAX);
        assert_eq!(retry_backoff(40), RETRY_BACKOFF_MAX);
    }
}
