use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::v2::StartProcess;

pub(crate) const ARG_LIMIT: usize = 32 * 1024;
pub(crate) const GUARDIAN_ARGUMENT: &str = "__shared-execution-guardian";
const FRAME_LIMIT: usize = 384 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Owner {
    pub(crate) proofs: PathBuf,
    pub(crate) process_id: String,
    pub(crate) nonce: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Launch {
    pub(crate) root: PathBuf,
    pub(crate) root_identity: (u64, u64),
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) deadline_ns: u64,
    pub(crate) lease_deadline_ns: Option<u64>,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: String,
    pub(crate) stdin: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Proof {
    pub(crate) process_id: String,
    pub(crate) nonce: String,
    pub(crate) outcome: Outcome,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    Cancelled,
    TimedOut,
    LaunchFailed,
    Unobserved,
}

pub(crate) fn validate(input: &StartProcess) -> bool {
    !input.command.is_empty()
        && input.command.len() <= 1024
        && !input.command.contains('\0')
        && (1..=86_400_000).contains(&input.timeout_ms)
        && input.args.len() <= 128
        && input.args.iter().all(|value| !value.contains('\0'))
        && input.args.iter().map(String::len).sum::<usize>() <= ARG_LIMIT
        && input.stdin.len() <= ARG_LIMIT
        && input.cwd.len() <= 1024
}

pub(crate) fn encode_frame(value: &impl Serialize) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    ensure!(
        !body.is_empty() && body.len() <= FRAME_LIMIT,
        "guardian frame exceeds limit"
    );
    let mut frame = (body.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub(crate) fn read_proof(directory: &Path, process_id: &str, nonce: &str) -> Result<Option<Proof>> {
    let path = directory.join(process_id);
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "process cleanup proof exceeds limit");
    let proof: Proof = serde_json::from_slice(&bytes)?;
    ensure!(
        proof.process_id == process_id && proof.nonce == nonce,
        "process cleanup proof does not match the admitted launch"
    );
    Ok(Some(proof))
}

pub(crate) fn monotonic_now_ns() -> io::Result<u64> {
    #[cfg(target_os = "linux")]
    let clock = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    let clock = libc::CLOCK_MONOTONIC;
    let mut value = std::mem::MaybeUninit::uninit();
    // SAFETY: clock_gettime initializes the provided timespec on success.
    if unsafe { libc::clock_gettime(clock, value.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful clock_gettime initialized the timespec.
    let value = unsafe { value.assume_init() };
    Ok(value.tv_sec as u64 * 1_000_000_000 + value.tv_nsec as u64)
}

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
pub(crate) use linux::run;

#[cfg(not(target_os = "linux"))]
pub(crate) fn run() -> Result<()> {
    anyhow::bail!("process guardian requires Linux")
}
