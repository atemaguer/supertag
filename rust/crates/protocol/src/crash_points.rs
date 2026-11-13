//! Test-only process-kill barriers for the crash-durability matrix.
//!
//! Each service names the exact durable boundaries it crosses. A test selects one
//! boundary with `SUPERTAG_TEST_CRASH_POINT=<scope>.<boundary>`; the process then
//! records the boundary in `SUPERTAG_TEST_CRASH_MARKER` and delivers `SIGKILL` to
//! itself, so no destructor, flush, or signal handler can run. Without the
//! `crash-points` feature every call compiles to nothing, and release archives
//! never enable that feature.

/// Environment variable that selects one `<scope>.<boundary>` crash point.
pub const CRASH_POINT_ENV: &str = "SUPERTAG_TEST_CRASH_POINT";
/// Environment variable naming the file written immediately before the crash.
pub const CRASH_MARKER_ENV: &str = "SUPERTAG_TEST_CRASH_MARKER";

/// Kill this process at `<scope>.<boundary>` when a test selected that point.
#[cfg(feature = "crash-points")]
pub fn crash_point(scope: &str, boundary: &str) {
    use std::sync::OnceLock;
    static TARGET: OnceLock<Option<String>> = OnceLock::new();
    let target = TARGET.get_or_init(|| std::env::var(CRASH_POINT_ENV).ok());
    let selected = target
        .as_deref()
        .and_then(|target| target.strip_prefix(scope))
        .and_then(|rest| rest.strip_prefix('.'))
        == Some(boundary);
    if selected {
        crash_now(
            &format!("{scope}.{boundary}"),
            std::env::var_os(CRASH_MARKER_ENV).as_deref(),
        );
    }
}

#[cfg(not(feature = "crash-points"))]
#[inline(always)]
pub fn crash_point(_scope: &str, _boundary: &str) {}

/// Record `name` durably in `marker`, then `SIGKILL` this process.
#[cfg(feature = "crash-points")]
pub fn crash_now(name: &str, marker: Option<&std::ffi::OsStr>) -> ! {
    use std::io::Write as _;
    if let Some(marker) = marker {
        // Publish the marker atomically so an observer never reads a partial name.
        let mut staged = std::ffi::OsString::from(marker);
        staged.push(".staged");
        if let Ok(mut file) = std::fs::File::create(&staged)
            && file.write_all(name.as_bytes()).is_ok()
            && file.sync_all().is_ok()
        {
            let _ = std::fs::rename(&staged, marker);
        }
    }
    // SAFETY: kill and getpid have no memory-safety preconditions.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    loop {
        std::thread::park();
    }
}
