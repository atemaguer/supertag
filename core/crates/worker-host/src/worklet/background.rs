//! Host-wide work the Worklet runs in the background while it claims: deleting held checkpoints
//! no Session will resume, and Volume objects nothing keeps.

use std::{collections::BTreeMap, time::Duration};

use supertag_workspaces::artifact_volumes::FileVolume;
use tokio_util::sync::CancellationToken;

use crate::worklet::{checkpoints, volume_objects};

/// At start and every hour, deletes the checkpoint files no Session will resume.
pub(crate) fn reconcile_checkpoints(
    transfers: &checkpoints::Transfers,
    shutdown: &CancellationToken,
) {
    let transfers = transfers.clone();
    let shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = transfers.reconcile().await {
                crate::failures::note("held checkpoints could not be reconciled", &error);
            }
            tokio::select! {
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(Duration::from_secs(60 * 60)) => {}
            }
        }
    });
}

/// At start and every 10 minutes, deletes the objects nothing keeps from the file Volumes this
/// host maps.
pub(crate) fn collect_volume_garbage(
    volumes: &BTreeMap<String, FileVolume>,
    client: &volume_objects::VolumeObjects,
    shutdown: &CancellationToken,
) {
    let volumes = std::sync::Arc::new(volumes.clone());
    let client = client.clone();
    let shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = volume_objects::collect_garbage(&client, &volumes).await {
                crate::failures::note("Volume garbage could not be deleted", &error);
            }
            tokio::select! {
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(volume_objects::GARBAGE_INTERVAL) => {}
            }
        }
    });
}
