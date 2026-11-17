//! A test process that dies takes the services it spawned with it (support/children.rs).
//!
//! Each case runs [`spawn_a_control_plane_then_die`] in a separate test process. That process
//! starts a real Control Plane without any `Drop` guard, records its PID, and then panics or is
//! killed with `SIGKILL`. The outer test asserts the Control Plane is gone afterwards.
#[path = "support/children.rs"]
mod children;

use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use children::reaped;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const PID_FILE: &str = "SUPERTAG_TEST_CHILD_CLEANUP_PID_FILE";
const MODE: &str = "SUPERTAG_TEST_CHILD_CLEANUP_MODE";

/// Run only as the inner process of the cases below.
#[test]
#[ignore = "inner process of the child_cleanup cases"]
// The point: nothing in this process waits on or kills the Control Plane.
#[allow(clippy::zombie_processes)]
fn spawn_a_control_plane_then_die() {
    let (Some(pid_file), Ok(mode)) = (std::env::var_os(PID_FILE), std::env::var(MODE)) else {
        return;
    };
    let pid_file = Path::new(&pid_file);
    let database = pid_file.with_file_name("control-plane.db");
    let log = pid_file.with_file_name("control-plane.log");
    let token = |prefix: &str| {
        format!(
            "{prefix}{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    };
    let gateway = token("stcr_");
    let host = token("stcr_");
    let mut child = reaped(Command::new(BINARY))
        .args(["control-plane", "--listen", "127.0.0.1:0"])
        .env_clear()
        .env(
            "SUPERTAG_DATABASE_URL",
            format!("sqlite://{}?mode=rwc", database.display()),
        )
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", uuid::Uuid::new_v4().to_string())
        .env("SUPERTAG_HOST_TOKEN", &host)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(&log).expect("Control Plane log"))
        .spawn()
        .expect("spawn the Control Plane");
    let mut endpoint = String::new();
    BufReader::new(child.stdout.take().expect("Control Plane stdout"))
        .read_line(&mut endpoint)
        .expect("read the Control Plane endpoint");
    assert!(
        endpoint
            .trim_start_matches("http://")
            .starts_with("127.0.0.1:"),
        "Control Plane did not start: {}",
        std::fs::read_to_string(&log).unwrap_or_default()
    );
    std::fs::write(pid_file, child.id().to_string()).expect("record the Control Plane PID");
    // `std::process::Child` neither kills nor waits on drop: only the watchdog can stop it.
    match mode.as_str() {
        "panic" => panic!("the test fails while its Control Plane is running"),
        _ => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
    }
}

#[test]
fn a_panicking_test_takes_its_control_plane_with_it() {
    let (directory, mut inner) = inner("panic");
    let status = inner.wait().expect("wait for the inner test");
    assert!(!status.success(), "the inner test should have panicked");
    assert_control_plane_stops(directory.path());
}

#[test]
fn a_killed_test_takes_its_control_plane_with_it() {
    let (directory, mut inner) = inner("kill");
    let pid = wait_for_pid(directory.path(), &mut inner);
    inner.kill().expect("SIGKILL the inner test");
    inner.wait().expect("reap the inner test");
    assert_control_plane_stops_pid(pid);
}

fn inner(mode: &str) -> (tempfile::TempDir, std::process::Child) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let child = Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "spawn_a_control_plane_then_die",
            "--include-ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(PID_FILE, directory.path().join("control-plane.pid"))
        .env(MODE, mode)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start the inner test");
    (directory, child)
}

fn wait_for_pid(directory: &Path, inner: &mut std::process::Child) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(pid) = std::fs::read_to_string(directory.join("control-plane.pid"))
            && let Ok(pid) = pid.trim().parse()
        {
            return pid;
        }
        assert!(
            inner.try_wait().expect("poll the inner test").is_none(),
            "the inner test exited before starting its Control Plane"
        );
        assert!(
            Instant::now() < deadline,
            "the inner test never started its Control Plane"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_control_plane_stops(directory: &Path) {
    let pid = std::fs::read_to_string(directory.join("control-plane.pid"))
        .expect("the inner test recorded its Control Plane PID")
        .trim()
        .parse()
        .expect("Control Plane PID");
    assert_control_plane_stops_pid(pid);
}

fn assert_control_plane_stops_pid(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    // The Control Plane is the watchdog's child-group member, not ours: once killed it is
    // reparented and reaped by init, so signal 0 fails with ESRCH.
    // SAFETY: signal 0 only checks that the process exists.
    while unsafe { libc::kill(pid, 0) } == 0 {
        if Instant::now() >= deadline {
            // SAFETY: the PID was this test's own leaked Control Plane moments ago.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            panic!("Control Plane {pid} outlived the test process that started it");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
