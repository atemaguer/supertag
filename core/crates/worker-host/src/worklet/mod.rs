//! The Worklet: the per-host program of a Worker Host. It registers the host, reports its
//! presence, claims Task Attempts and holds their leases, keeps the journal that recovery resumes
//! from, and owns the host's checkouts, Session checkpoints, held artifacts, landings, and
//! cleanup. It runs each claimed Attempt in a Worker.

pub(crate) mod artifact_direct;
pub(crate) mod authority;
pub(crate) mod background;
pub(crate) mod checkpoints;
pub(crate) mod claim;
pub(crate) mod cleanup_failure;
pub(crate) mod enrollment;
pub(crate) mod finish;
pub(crate) mod journal;
pub(crate) mod landing;
pub(crate) mod readiness;
pub(crate) mod recovery;
pub(crate) mod registration;
pub(crate) mod run;
pub(crate) mod shared_host;
pub(crate) mod volume_objects;
pub(crate) mod workspaces;
