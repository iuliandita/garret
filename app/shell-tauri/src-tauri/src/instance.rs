//! One window per library.
//!
//! A second launch against the same data home does not get a second window.
//! It asks the first window to come forward and exits. The hazard it closes
//! is narrow and stated in the decision record: two processes on one
//! `settings.json` are last-writer-wins, and two mirror passes can interleave
//! because `MirrorPassing` is a per-process mutex. The manuscript itself was
//! already safe (a stale `base_rev` is refused as a Conflict).
//!
//! Scoped by DATA HOME, not by user: a rig running the binary against a fresh
//! `XDG_DATA_HOME` is a different library and must get its own window, or it
//! would silently focus the owner's application instead of starting. The
//! socket lives in `XDG_RUNTIME_DIR` (per-user tmpfs, gone at logout) under a
//! hash of the data home path, because a socket path is limited to 108 bytes
//! and a rig's data home is routinely longer than that. Not D-Bus: several
//! rigs cut the session bus on purpose, and the ones that keep it share the
//! operator's.
//!
//! Losing the guard is not fatal. A library that cannot bind a socket runs
//! unguarded and says so on stderr; refusing to open a writer's book over a
//! convenience would be the wrong priority.

use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// The socket path length Linux accepts, minus the terminating byte.
const SOCKET_PATH_MAX: usize = 107;

/// What a launch found when it looked for another window on this library.
pub(crate) enum Claim {
    /// This process is the window. Serve the listener until exit, then
    /// remove the file at `path`.
    Owned(UnixListener, PathBuf),
    /// Another process is the window and has been asked to come forward.
    Forwarded,
    /// No guard could be established; run unguarded.
    Unavailable(String),
}

/// FNV-1a over the path bytes. Not a security boundary: the only requirement
/// is that two different libraries get two different names and one library
/// gets the same name on every launch.
fn library_key(data_home: &Path) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_home.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// `<runtime_dir>/cc.local.app-<key>.sock`.
pub(crate) fn socket_path(runtime_dir: &Path, data_home: &Path) -> PathBuf {
    runtime_dir.join(format!("cc.local.app-{:016x}.sock", library_key(data_home)))
}

/// The runtime directory this user has, or the system temp directory when the
/// session set none (a rig that launches with a scrubbed environment, a
/// console login).
fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(std::env::temp_dir)
}

/// The runtime directory first, the temp directory when that one cannot hold
/// a socket (a session whose `XDG_RUNTIME_DIR` is itself too long, which a
/// harness scratch directory is).
pub(crate) fn claim(data_home: &Path) -> Claim {
    let first = claim_in(&runtime_dir(), data_home);
    match first {
        Claim::Unavailable(_) => claim_in(&std::env::temp_dir(), data_home),
        settled => settled,
    }
}

/// Bind, or ask the process that did to come forward. A socket file with no
/// process behind it (the last window was killed rather than closed) is taken
/// over, because a connection to it is refused rather than accepted.
pub(crate) fn claim_in(runtime_dir: &Path, data_home: &Path) -> Claim {
    let path = socket_path(runtime_dir, data_home);
    if path.as_os_str().len() > SOCKET_PATH_MAX {
        return Claim::Unavailable(format!(
            "{} is longer than a socket path may be",
            path.display()
        ));
    }
    match UnixListener::bind(&path) {
        Ok(listener) => Claim::Owned(listener, path.clone()),
        Err(bind_err) if bind_err.kind() == std::io::ErrorKind::AddrInUse => {
            match UnixStream::connect(&path) {
                Ok(mut stream) => {
                    // The connection is the message; the byte is so the
                    // listener has something to read to completion.
                    let _ = stream.write_all(b"focus\n");
                    Claim::Forwarded
                }
                Err(_) => {
                    // Nobody is listening: a stale file from a killed process.
                    if let Err(e) = std::fs::remove_file(&path) {
                        return Claim::Unavailable(format!(
                            "{}: stale, and cannot be removed: {e}",
                            path.display()
                        ));
                    }
                    match UnixListener::bind(&path) {
                        Ok(listener) => Claim::Owned(listener, path.clone()),
                        Err(e) => Claim::Unavailable(format!("{}: {e}", path.display())),
                    }
                }
            }
        }
        Err(e) => Claim::Unavailable(format!("{}: {e}", path.display())),
    }
}

/// Accepts forever on its own thread; every connection is one request to come
/// forward. Reading the byte to completion is what keeps the second process's
/// write from failing with a reset before it exits.
pub(crate) fn serve(listener: UnixListener, on_focus: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("instance".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if let Ok(mut stream) = stream {
                    let mut sink = Vec::new();
                    let _ = std::io::Read::read_to_end(&mut stream, &mut sink);
                    on_focus();
                }
            }
        })
        .expect("spawning the instance listener thread");
}

/// The socket file, when this process was the window and is leaving.
pub(crate) fn release(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn the_first_launch_owns_the_socket_and_the_second_is_forwarded_to_it() {
        let run = tempdir().unwrap();
        let home = Path::new("/home/someone/.local/share");
        let listener = match claim_in(run.path(), home) {
            Claim::Owned(l, _) => l,
            _ => panic!("the first launch must own the socket"),
        };
        let (tx, rx) = mpsc::channel();
        serve(listener, move || tx.send(()).unwrap());

        assert!(matches!(claim_in(run.path(), home), Claim::Forwarded));
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the owner must be asked to come forward");
    }

    #[test]
    fn a_socket_file_with_nobody_behind_it_is_taken_over() {
        let run = tempdir().unwrap();
        let home = Path::new("/home/someone/.local/share");
        let path = socket_path(run.path(), home);
        // Bind and drop: the file stays, the listener is gone, as after SIGKILL.
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        assert!(matches!(claim_in(run.path(), home), Claim::Owned(..)));
    }

    #[test]
    fn two_libraries_get_two_sockets_and_one_library_always_the_same() {
        let run = Path::new("/run/user/1000");
        let a = socket_path(run, Path::new("/home/a/.local/share"));
        let b = socket_path(run, Path::new("/tmp/rig/data"));
        assert_ne!(a, b);
        assert_eq!(a, socket_path(run, Path::new("/home/a/.local/share")));
    }

    #[test]
    fn a_long_library_path_still_fits_a_socket_path() {
        let long = Path::new(
            "/tmp/garret-test-0000/data-home/deeply/nested/library-path/for/a/rig/run/generation/a1b2c3d4-e5f6-7890-abcd-ef1234567890/data",
        );
        assert!(long.as_os_str().len() > SOCKET_PATH_MAX);
        let path = socket_path(Path::new("/run/user/1000"), long);
        assert!(path.as_os_str().len() <= SOCKET_PATH_MAX);
    }

    #[test]
    fn a_runtime_dir_that_does_not_exist_leaves_the_library_unguarded_not_closed() {
        let claim = claim_in(Path::new("/nonexistent/run"), Path::new("/home/x"));
        assert!(matches!(claim, Claim::Unavailable(_)));
    }

    #[test]
    fn release_removes_exactly_the_file_the_claim_bound() {
        let run = tempdir().unwrap();
        let home = Path::new("/home/someone/.local/share");
        let (listener, path) = match claim_in(run.path(), home) {
            Claim::Owned(l, p) => (l, p),
            _ => panic!("the first launch must own the socket"),
        };
        assert!(path.exists());
        drop(listener);
        release(&path);
        assert!(!path.exists());
    }
}
