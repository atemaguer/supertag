use std::{
    fs::{self, File},
    io::{self, Read, Seek, Write},
    os::{
        fd::{AsFd, AsRawFd, RawFd},
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, Stdio},
    time::Duration,
};

use anyhow::{Result, ensure};
use serde::de::DeserializeOwned;

use super::{FRAME_LIMIT, Launch, Outcome, Owner, Proof, monotonic_now_ns};
use crate::root::Root;

pub(crate) fn run() -> Result<()> {
    seal_inherited_descriptors()?;
    // A parent may have explicitly ignored SIGCHLD. Retain our zombies until we reap them,
    // so a kernel child ID cannot be reused between enumeration and signalling.
    // SAFETY: this single-threaded guardian has no children yet.
    ensure!(
        unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) } != libc::SIG_ERR,
        "initialize guardian child reaping"
    );
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let owner: Owner = frame(&mut input)?;
    ensure!(
        owner.proofs.is_absolute()
            && uuid::Uuid::parse_str(&owner.process_id).is_ok()
            && uuid::Uuid::parse_str(&owner.nonce).is_ok(),
        "invalid guardian owner frame"
    );
    // SAFETY: this single-threaded guardian adopts every orphan in its workload process tree.
    let result = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
    ensure!(result == 0, "enable guardian child ownership");
    let launch: Result<Launch> = frame(&mut input);
    drop(input);
    let outcome = match launch {
        Ok(launch) => supervise(&stdin, launch).unwrap_or(Outcome::LaunchFailed),
        Err(_) => Outcome::LaunchFailed,
    };
    reap_descendants()?;
    let proof = Proof {
        process_id: owner.process_id.clone(),
        nonce: owner.nonce,
        outcome,
    };
    let mut file = tempfile::NamedTempFile::new_in(&owner.proofs)?;
    serde_json::to_writer(file.as_file_mut(), &proof)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(owner.proofs.join(owner.process_id))?;
    File::open(&owner.proofs)?.sync_all()?;
    Ok(())
}

fn seal_inherited_descriptors() -> io::Result<()> {
    for entry in fs::read_dir("/proc/self/fd")? {
        let entry = entry?;
        let Some(fd) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<RawFd>().ok())
        else {
            continue;
        };
        if fd <= libc::STDERR_FILENO {
            continue;
        }
        // SAFETY: the guardian is single-threaded, and this only changes the descriptor's exec flag.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EBADF) {
                return Err(error);
            }
        }
    }
    Ok(())
}

fn frame<T: DeserializeOwned>(input: &mut impl Read) -> Result<T> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    ensure!(
        (1..=FRAME_LIMIT).contains(&length),
        "guardian frame exceeds limit"
    );
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn supervise(stdin: &io::Stdin, launch: Launch) -> Result<Outcome> {
    ensure!(
        launch.uid > 0 && launch.gid > 0,
        "invalid workload identity"
    );
    let root = Root::open(&launch.root, None)?;
    ensure!(
        root.identity == launch.root_identity,
        "fixed execution root changed before launch"
    );
    let cwd = root.directory(&launch.cwd)?;
    let lifeline = stdin.as_fd().try_clone_to_owned()?;
    let deadline = launch.deadline_ns;
    check_owner(lifeline.as_raw_fd(), deadline)?;
    let mut input = tempfile::tempfile()?;
    input.write_all(&launch.stdin)?;
    input.rewind()?;
    let mut command = Command::new(&launch.command);
    command
        .args(&launch.args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", &root.path)
        .stdin(Stdio::from(input))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .uid(launch.uid)
        .gid(launch.gid);
    // SAFETY: the child callback uses only nonblocking kernel operations and does not allocate.
    unsafe {
        command.pre_exec(move || {
            check_owner(lifeline.as_raw_fd(), deadline)?;
            if libc::fchdir(cwd.as_raw_fd()) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    Ok(wait_child(&mut child, stdin.as_fd().as_raw_fd(), deadline).unwrap_or(Outcome::Unobserved))
}

fn wait_child(child: &mut Child, owner: RawFd, deadline: u64) -> io::Result<Outcome> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Outcome::Exited {
                code: status.code(),
                signal: status.signal(),
            });
        }
        if monotonic_now_ns()? >= deadline {
            return Ok(Outcome::TimedOut);
        }
        if owner_closed(owner, 10)? {
            return Ok(Outcome::Cancelled);
        }
    }
}

fn check_owner(fd: RawFd, deadline: u64) -> io::Result<()> {
    if owner_closed(fd, 0)? {
        return Err(io::Error::from_raw_os_error(libc::EPIPE));
    }
    if monotonic_now_ns()? >= deadline {
        return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
    }
    Ok(())
}

fn owner_closed(fd: RawFd, wait_ms: i32) -> io::Result<bool> {
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: descriptor is initialized and points to one pollfd.
    let ready = unsafe { libc::poll(&mut descriptor, 1, wait_ms) };
    if ready < 0 {
        return Err(io::Error::last_os_error());
    }
    // No messages are valid after the launch frame. Any readiness closes authority.
    Ok(ready != 0)
}

fn reap_descendants() -> Result<()> {
    loop {
        loop {
            let mut status = 0;
            // SAFETY: this is the only reaper for the guardian's direct children.
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG | libc::__WALL) };
            if pid > 0 {
                continue;
            }
            if pid == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                return Ok(());
            }
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error.into());
            }
        }
        // Direct children may create new groups or sessions. Orphans of killed children are
        // adopted by this guardian and reaped in the next pass. A PID cannot be reused until
        // its child has been reaped, and this process performs no wait while signalling this set.
        if let Ok(children) = fs::read_to_string("/proc/thread-self/children") {
            for pid in children
                .split_whitespace()
                .filter_map(|value| value.parse::<libc::pid_t>().ok())
                .filter(|pid| *pid > 0)
            {
                // SAFETY: the current kernel child list provides these unreaped child PIDs.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
        // A process stuck in the kernel can keep cleanup pending. No proof is written in that case.
        std::thread::sleep(Duration::from_millis(10));
    }
}
