//! Per-data-home GUI ownership for Windows. The lock file is never removed:
//! removing it would let a new process lock a different file at the same name.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MIGRATED_CONTENT: &[u8] = b"garret-storage-v1\n";

const RETRY_DELAY: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) struct Guard {
    _file: File,
}

impl Guard {
    pub(crate) fn migrated(&self) -> Result<bool, String> {
        self._file
            .metadata()
            .map(|metadata| metadata.len() != 0)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn mark_migrated(&self) -> Result<(), String> {
        let mut file = &self._file;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(MIGRATED_CONTENT))
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())
    }
}

pub(crate) enum Claim {
    Owned(Guard),
    Forwarded,
    Unavailable(String),
}

fn app_dir(data_home: &Path) -> io::Result<PathBuf> {
    if !data_home.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "data home must be absolute",
        ));
    }
    Ok(data_home.join("cc.local.app"))
}

fn lock_path(data_home: &Path) -> io::Result<PathBuf> {
    Ok(app_dir(data_home)?.join("instance.lock"))
}

fn marker_path(data_home: &Path) -> io::Result<PathBuf> {
    Ok(app_dir(data_home)?.join("focus.request"))
}

fn open_lock(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Let another launcher open the file, but never replace it while live.
        // OPEN_REPARSE_POINT lets handle metadata reject the link itself.
        options.share_mode(0x0000_0003).custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "instance lock is not a regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x0000_0400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "instance lock is a reparse point",
            ));
        }
    }
    Ok(file)
}

fn try_claim(path: &Path) -> io::Result<Option<Guard>> {
    let file = open_lock(path)?;
    match file.try_lock() {
        Ok(()) => {
            let mut reader = &file;
            reader.seek(SeekFrom::Start(0))?;
            let mut content = Vec::new();
            reader.take(MIGRATED_CONTENT.len() as u64 + 1)
                .read_to_end(&mut content)?;
            if !content.is_empty() && content != MIGRATED_CONTENT {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "instance lock contains an unknown record",
                ));
            }
            Ok(Some(Guard { _file: file }))
        }
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

fn request_focus(marker: &Path) -> io::Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(marker) {
        Ok(file) => drop(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            match fs::symlink_metadata(marker) {
                Ok(metadata) if metadata.is_file() && metadata.len() == 0 => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "focus request marker is not an empty regular file",
                    ))
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

pub(crate) fn claim(data_home: &Path) -> Claim {
    let outcome = (|| -> io::Result<Claim> {
        let path = lock_path(data_home)?;
        let marker = marker_path(data_home)?;
        fs::create_dir_all(app_dir(data_home)?)?;
        if let Some(guard) = try_claim(&path)? {
            return Ok(Claim::Owned(guard));
        }
        request_focus(&marker)?;
        std::thread::sleep(RETRY_DELAY);
        Ok(match try_claim(&path)? {
            Some(guard) => Claim::Owned(guard),
            None => Claim::Forwarded,
        })
    })();
    outcome.unwrap_or_else(|error| Claim::Unavailable(error.to_string()))
}

fn take_focus(marker: &Path) -> io::Result<bool> {
    match fs::remove_file(marker) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Start only after the main window exists. A request coalesces into one file.
pub(crate) fn serve(data_home: &Path, on_focus: impl Fn() + Send + 'static) -> io::Result<()> {
    let marker = marker_path(data_home)?;
    let mut reported_error = false;
    std::thread::Builder::new()
        .name("instance-focus".into())
        .spawn(move || loop {
            std::thread::sleep(POLL_INTERVAL);
            match take_focus(&marker) {
                Ok(true) => {
                    reported_error = false;
                    on_focus();
                }
                Ok(false) => reported_error = false,
                Err(error) if !reported_error => {
                    eprintln!("instance focus request: {error}");
                    reported_error = true;
                }
                Err(_) => (),
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn libraries_are_isolated_and_marker_requests_coalesce() {
        let root = tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let guard = match claim(&first) {
            Claim::Owned(guard) => guard,
            _ => panic!("first claim"),
        };
        assert!(matches!(claim(&second), Claim::Owned(_)));
        let marker = marker_path(&first).unwrap();
        request_focus(&marker).unwrap();
        request_focus(&marker).unwrap();
        assert_eq!(
            fs::read_dir(marker.parent().unwrap())
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().file_name() == "focus.request")
                .count(),
            1
        );
        assert!(take_focus(&marker).unwrap());
        assert!(!take_focus(&marker).unwrap());
        drop(guard);
    }

    #[test]
    fn invalid_home_and_lock_object_refuse_ownership() {
        assert!(matches!(
            claim(Path::new("relative")),
            Claim::Unavailable(_)
        ));
        let root = tempdir().unwrap();
        let dir = app_dir(root.path()).unwrap();
        fs::create_dir_all(dir.join("instance.lock")).unwrap();
        assert!(matches!(claim(root.path()), Claim::Unavailable(_)));
        let nonempty_root = tempdir().unwrap();
        let nonempty_dir = app_dir(nonempty_root.path()).unwrap();
        fs::create_dir_all(&nonempty_dir).unwrap();
        fs::write(nonempty_dir.join("instance.lock"), b"not empty").unwrap();
        assert!(matches!(claim(nonempty_root.path()), Claim::Unavailable(_)));
        let marker_root = tempdir().unwrap();
        let marker_dir = app_dir(marker_root.path()).unwrap();
        fs::create_dir_all(marker_dir.join("focus.request")).unwrap();
        assert!(request_focus(&marker_dir.join("focus.request")).is_err());
    }

    #[test]
    fn child_holds_lock_until_killed() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let root = tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "instance_file::tests::lock_holder_child",
                "--nocapture",
            ])
            .env("INSTANCE_LOCK_TEST_HOME", root.path())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while output.read_line(&mut line).unwrap() != 0 {
            if line.contains("INSTANCE_LOCK_READY") {
                break;
            }
            line.clear();
        }
        assert!(
            line.contains("INSTANCE_LOCK_READY"),
            "child never acquired lock: {line}"
        );
        assert!(matches!(claim(root.path()), Claim::Forwarded));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(matches!(claim(root.path()), Claim::Owned(_)));
    }

    #[test]
    fn lock_holder_child() {
        let Some(home) = std::env::var_os("INSTANCE_LOCK_TEST_HOME") else {
            return;
        };
        let guard = match claim(Path::new(&home)) {
            Claim::Owned(guard) => guard,
            _ => panic!("child claim"),
        };
        guard.mark_migrated().unwrap();
        println!("INSTANCE_LOCK_READY");
        std::thread::sleep(Duration::from_secs(30));
    }
}
