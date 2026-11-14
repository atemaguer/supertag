//! Exclusive state-directory ownership that ends exactly when its owner drops.
use std::fs::File;

/// An exclusive `flock` that is released when this value drops.
///
/// `flock` ownership belongs to the open file description, not the descriptor. A child
/// process spawned concurrently on another thread briefly shares every descriptor until
/// its exec closes the close-on-exec ones, so merely closing ours can leave the lock held
/// past drop and make an immediate reopen in this process fail. Unlocking explicitly
/// releases the description's lock regardless of those transient copies.
#[derive(Debug)]
pub struct ExclusiveLock(File);

impl ExclusiveLock {
    /// Take the lock without blocking; fails if any other description holds it.
    pub fn try_acquire(file: File) -> std::io::Result<Self> {
        file.try_lock()?;
        Ok(Self(file))
    }
}

impl std::ops::Deref for ExclusiveLock {
    type Target = File;

    fn deref(&self) -> &File {
        &self.0
    }
}

impl Drop for ExclusiveLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        process::{Command, Stdio},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    /// Run `body` while four threads continuously spawn children. Each child briefly
    /// shares this process's open file descriptions until its exec closes them.
    pub(crate) fn while_children_spawn<T>(body: impl FnOnce() -> T) -> T {
        let stop = Arc::new(AtomicBool::new(false));
        let spawners = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = Command::new("/usr/bin/true").stdin(Stdio::null()).status();
                    }
                })
            })
            .collect::<Vec<_>>();
        let result = body();
        stop.store(true, Ordering::Relaxed);
        for spawner in spawners {
            spawner.join().expect("spawner thread panicked");
        }
        result
    }
}
