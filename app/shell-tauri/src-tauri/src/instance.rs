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

use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

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
    /// A connected peer could not be verified; run without forwarding.
    UnverifiedPeer(String),
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

/// Create privately, then check the existing entry without following symlinks.
fn fallback_dir(temp: &Path, uid: u32) -> Result<PathBuf, String> {
    let dir = temp.join(format!("cc.local.app-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(format!("{}: {error}", dir.display())),
    }
    let meta =
        std::fs::symlink_metadata(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(format!(
            "{}: instance directory must be private and owned by this user",
            dir.display()
        ));
    }
    Ok(dir)
}

/// Use the session runtime directory when it can hold the socket, otherwise a
/// checked per-user directory beneath the system temp directory.
pub(crate) fn claim(data_home: &Path) -> Claim {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    if let Some(dir) = runtime.filter(|dir| dir.is_absolute()) {
        match claim_in(&dir, data_home) {
            Claim::Unavailable(_) => (),
            settled => return settled,
        }
    }
    match fallback_dir(&std::env::temp_dir(), rustix::process::geteuid().as_raw()) {
        Ok(dir) => claim_in(&dir, data_home),
        Err(error) => Claim::Unavailable(error),
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the live socket fd and writable buffer/length describe exactly
    // one ucred. The buffer is read only after success and a full-size result.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::other("incomplete instance peer credentials"));
    }
    Ok(unsafe { credentials.assume_init() }.uid)
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the socket fd is live and both output pointers are valid.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
)))]
fn peer_uid(_stream: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "instance peer credentials are unavailable",
    ))
}

/// Bind, or ask the process that did to come forward. A socket file with no
/// process behind it (the last window was killed rather than closed) is taken
/// over, because a connection to it is refused rather than accepted.
pub(crate) fn claim_in(runtime_dir: &Path, data_home: &Path) -> Claim {
    claim_in_with(runtime_dir, data_home, peer_uid)
}

fn claim_in_with(
    runtime_dir: &Path,
    data_home: &Path,
    check_peer: impl Fn(&UnixStream) -> io::Result<u32>,
) -> Claim {
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
                    match check_peer(&stream) {
                        Ok(uid) if uid == rustix::process::geteuid().as_raw() => (),
                        Ok(_) => {
                            return Claim::UnverifiedPeer(
                                "instance peer belongs to another user".into(),
                            )
                        }
                        Err(error) => {
                            return Claim::UnverifiedPeer(format!(
                                "cannot verify instance peer: {error}"
                            ))
                        }
                    }
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
/// forward. A bounded read drains the short request without waiting for EOF;
/// idle connections time out so the listener can accept the next launch.
pub(crate) fn serve(listener: UnixListener, on_focus: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("instance".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if let Ok(mut stream) = stream {
                    if stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .is_err()
                    {
                        continue;
                    }
                    let mut message = [0; 6];
                    if matches!(stream.read(&mut message), Ok(n) if n > 0) {
                        on_focus();
                    }
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
    fn an_unverified_listener_is_not_forwarded_or_removed() {
        let run = tempdir().unwrap();
        let home = Path::new("/library");
        let path = socket_path(run.path(), home);
        let listener = UnixListener::bind(&path).unwrap();
        for result in [
            Ok(rustix::process::geteuid().as_raw().wrapping_add(1)),
            Err(io::Error::other("credentials unavailable")),
        ] {
            let result = std::cell::RefCell::new(Some(result));
            assert!(matches!(
                claim_in_with(run.path(), home, |_| result.borrow_mut().take().unwrap()),
                Claim::UnverifiedPeer(_)
            ));
            let (mut peer, _) = listener.accept().unwrap();
            let mut message = Vec::new();
            peer.read_to_end(&mut message).unwrap();
            assert!(
                message.is_empty(),
                "unverified peers receive no focus request"
            );
            assert!(path.exists(), "a listening socket must not be removed");
        }
    }

    #[test]
    fn fallback_directory_is_private_and_refuses_wrong_mode_owner_and_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let run = tempdir().unwrap();
        std::fs::set_permissions(run.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let uid = rustix::process::geteuid().as_raw();
        let dir = fallback_dir(run.path(), uid).unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&dir).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(fallback_dir(run.path(), uid).unwrap(), dir);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(fallback_dir(run.path(), uid).is_err());
        std::fs::remove_dir(&dir).unwrap();
        symlink(run.path(), &dir).unwrap();
        assert!(fallback_dir(run.path(), uid).is_err());
        // The expected uid is injected so this exercises ownership without root.
        let other = uid.wrapping_add(1);
        let other_dir = run.path().join(format!("cc.local.app-{other}"));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(other_dir)
            .unwrap();
        assert!(fallback_dir(run.path(), other).is_err());
    }

    #[test]
    fn an_idle_client_does_not_block_the_next_focus_request() {
        let run = tempdir().unwrap();
        let home = Path::new("/library");
        let listener = match claim_in(run.path(), home) {
            Claim::Owned(listener, _) => listener,
            _ => panic!("the first launch must own the socket"),
        };
        let idle = UnixStream::connect(socket_path(run.path(), home)).unwrap();
        let (tx, rx) = mpsc::channel();
        serve(listener, move || {
            let _ = tx.send(());
        });
        assert!(matches!(claim_in(run.path(), home), Claim::Forwarded));
        let focused = rx.recv_timeout(Duration::from_secs(3));
        drop(idle);
        focused.expect("serve must resume while the idle client is still connected");
    }

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
