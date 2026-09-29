//! Publish a fully prepared, host-owned book copy with the database last.
//! The caller verifies its contents and retains the private stage on failure.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

trait Operations {
    fn move_new(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn sync_file(&self, path: &Path) -> io::Result<()>;
    fn sync_dir(&self, path: &Path) -> io::Result<()>;
}

struct RealOperations;

impl Operations for RealOperations {
    fn move_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
        {
            // rustix maps NOREPLACE to renameat2 on Linux/Android and
            // renameatx_np(RENAME_EXCL) on macOS. Unsupported kernels return an
            // error; neither backend falls back to replacing the destination.
            rustix::fs::renameat_with(
                rustix::fs::CWD,
                from,
                rustix::fs::CWD,
                to,
                rustix::fs::RenameFlags::NOREPLACE,
            )
            .map_err(Into::into)
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
            fn wide(path: &Path) -> io::Result<Vec<u16>> {
                let mut chars: Vec<u16> = path.as_os_str().encode_wide().collect();
                if chars.contains(&0) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "path contains NUL",
                    ));
                }
                chars.push(0);
                Ok(chars)
            }
            // No REPLACE_EXISTING or COPY_ALLOWED: the operation fails on an
            // occupied destination or a cross-volume move.
            let from = wide(from)?;
            let to = wide(to)?;
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        #[cfg(not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            windows
        )))]
        {
            let _ = (from, to);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "exclusive transfer publication is unavailable on this platform",
            ))
        }
    }

    fn sync_file(&self, path: &Path) -> io::Result<()> {
        File::open(path)?.sync_all()
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            File::open(path)?.sync_all()
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "directory durability is unavailable on this platform",
            ))
        }
    }
}

fn regular(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(format!("{} is not a regular staged file", path.display()));
    }
    Ok(())
}

fn directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(format!("{} is not a real directory", path.display()));
    }
    Ok(())
}

fn sidecar(db: &Path, suffix: &str) -> Result<PathBuf, String> {
    let stem = db
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("book name is invalid")?;
    let parent = db.parent().ok_or("book path has no parent")?;
    Ok(parent.join(format!("{stem}.{suffix}")))
}

fn validate_paths(staged_db: &Path, dest_db: &Path) -> Result<(), String> {
    if !staged_db.is_absolute() || !dest_db.is_absolute() {
        return Err("transfer publication requires absolute paths".into());
    }
    if staged_db.extension().and_then(|ext| ext.to_str()) != Some("db")
        || dest_db.extension().and_then(|ext| ext.to_str()) != Some("db")
    {
        return Err("transfer publication requires .db paths".into());
    }
    let stem = dest_db
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("destination name is invalid")?;
    let id = uuid::Uuid::parse_str(stem).map_err(|_| "destination book name must be a UUID")?;
    if id.to_string() != stem {
        return Err("destination book name must be a canonical UUID".into());
    }
    let stage_parent = staged_db.parent().ok_or("stage has no parent")?;
    let dest_parent = dest_db.parent().ok_or("destination has no parent")?;
    if stage_parent == dest_parent {
        return Err("stage and destination must have different parents".into());
    }
    directory(stage_parent)?;
    directory(dest_parent)?;
    regular(staged_db)?;
    directory(&sidecar(staged_db, "pictures")?)?;
    directory(&sidecar(staged_db, "research")?)?;
    Ok(())
}

fn rollback(
    ops: &impl Operations,
    moved: &[(&Path, &Path)],
    stage_parent: &Path,
    dest_parent: &Path,
) -> Vec<String> {
    let mut errors = Vec::new();
    for (from, to) in moved.iter().rev() {
        // A reversal may only name a destination this operation just claimed.
        // NOREPLACE protects a newly occupied stage path too.
        if let Err(error) = ops.move_new(to, from) {
            errors.push(format!(
                "{} remains at {}: {error}",
                from.display(),
                to.display()
            ));
            // Once the database is visible, never strip its assets. Report
            // every retained owned path for inspection by the caller.
            if to.extension().and_then(|ext| ext.to_str()) == Some("db") {
                for (asset_stage, asset_dest) in moved.iter().take(moved.len() - 1) {
                    errors.push(format!(
                        "{} remains at {} because database rollback failed",
                        asset_stage.display(),
                        asset_dest.display()
                    ));
                }
                break;
            }
        }
    }
    for parent in [stage_parent, dest_parent] {
        if let Err(error) = ops.sync_dir(parent) {
            errors.push(format!(
                "{} could not be synced after rollback: {error}",
                parent.display()
            ));
        }
    }
    errors
}

fn sync_sidecar_files(ops: &impl Operations, dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let path = entry.map_err(|e| format!("{}: {e}", dir.display()))?.path();
        regular(&path)?;
        ops.sync_file(&path)
            .map_err(|e| format!("staged asset sync failed at {}: {e}", path.display()))?;
    }
    Ok(())
}

fn publish_with(ops: &impl Operations, staged_db: &Path, dest_db: &Path) -> Result<(), String> {
    validate_paths(staged_db, dest_db)?;
    let stage_parent = staged_db.parent().ok_or("stage has no parent")?;
    let dest_parent = dest_db.parent().ok_or("destination has no parent")?;
    let staged_pictures = sidecar(staged_db, "pictures")?;
    let staged_research = sidecar(staged_db, "research")?;
    let dest_pictures = sidecar(dest_db, "pictures")?;
    let dest_research = sidecar(dest_db, "research")?;

    // Reject an occupied catalog name before attaching any new assets to it.
    // Each later move remains exclusive to close admission races.
    for dest in [&dest_pictures, &dest_research, dest_db] {
        match fs::symlink_metadata(dest) {
            Ok(_) => return Err(format!("destination already occupied: {}", dest.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "destination check failed at {}: {error}",
                    dest.display()
                ))
            }
        }
    }

    // An accepted copy has already been validated by its caller. Flush its
    // staged bytes and names before any destination can become visible.
    ops.sync_file(staged_db)
        .map_err(|e| format!("staged book sync failed: {e}"))?;
    sync_sidecar_files(ops, &staged_pictures)?;
    sync_sidecar_files(ops, &staged_research)?;
    for dir in [&staged_pictures, &staged_research, stage_parent] {
        ops.sync_dir(dir)
            .map_err(|e| format!("staged directory sync failed at {}: {e}", dir.display()))?;
    }

    let steps = [
        (staged_pictures.as_path(), dest_pictures.as_path()),
        (staged_research.as_path(), dest_research.as_path()),
        (staged_db, dest_db),
    ];
    let mut moved: Vec<(&Path, &Path)> = Vec::new();
    let result = (|| {
        for (index, (from, to)) in steps.iter().enumerate() {
            ops.move_new(from, to)
                .map_err(|e| format!("exclusive move to {} failed: {e}", to.display()))?;
            moved.push((from, to));
            // Sidecars, including their contents, must be durable before the
            // DB move makes this candidate visible to library enumeration.
            if index < 2 {
                ops.sync_dir(to).map_err(|e| {
                    format!("published sidecar sync failed at {}: {e}", to.display())
                })?;
                ops.sync_dir(dest_parent)
                    .map_err(|e| format!("destination directory sync failed: {e}"))?;
            }
        }
        ops.sync_dir(dest_parent)
            .map_err(|e| format!("published book directory sync failed: {e}"))?;
        ops.sync_dir(stage_parent)
            .map_err(|e| format!("stage directory sync failed after publication: {e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let failures = rollback(ops, &moved, stage_parent, dest_parent);
        return if failures.is_empty() {
            Err(error)
        } else {
            Err(format!("{error}; rollback incomplete: {}; retain the private stage and inspect the named paths", failures.join("; ")))
        };
    }
    Ok(())
}

/// Publish one fully verified, copied book. The final `.db` move is the
/// visibility boundary; a failure leaves the staged copy or reports every
/// owned destination that could not be moved back. Never clean the stage on an
/// error without first inspecting that report.
pub(crate) fn publish(staged_db: &Path, dest_db: &Path) -> Result<(), String> {
    publish_with(&RealOperations, staged_db, dest_db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Faults {
        fail_at: Option<usize>,
        call: Cell<usize>,
        fail_rollback: bool,
        fail_db_rollback: bool,
        check_visibility: bool,
        moved: RefCell<Vec<PathBuf>>,
    }

    impl Faults {
        fn new(fail_at: Option<usize>, fail_rollback: bool) -> Self {
            Self {
                fail_at,
                call: Cell::new(0),
                fail_rollback,
                fail_db_rollback: false,
                check_visibility: false,
                moved: RefCell::new(Vec::new()),
            }
        }
        fn checking_visibility(mut self) -> Self {
            self.check_visibility = true;
            self
        }
        fn failing_db_rollback(mut self) -> Self {
            self.fail_db_rollback = true;
            self
        }
        fn step(&self) -> io::Result<()> {
            let next = self.call.get() + 1;
            self.call.set(next);
            if self.fail_at == Some(next) {
                Err(io::Error::other("injected publication failure"))
            } else {
                Ok(())
            }
        }
    }

    impl Operations for Faults {
        fn move_new(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.step()?;
            if self.check_visibility {
                if to.extension().and_then(|ext| ext.to_str()) == Some("db") {
                    assert!(sidecar(to, "pictures").unwrap().exists());
                    assert!(sidecar(to, "research").unwrap().exists());
                } else {
                    let db = to.with_extension("db");
                    assert!(!db.exists(), "database became visible before its sidecars");
                }
            }
            if self.fail_rollback
                && from.to_string_lossy().contains("library")
                && to.to_string_lossy().contains("stage")
            {
                return Err(io::Error::other("injected rollback failure"));
            }
            if self.fail_db_rollback
                && from.extension().and_then(|ext| ext.to_str()) == Some("db")
                && from
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|name| name.to_str())
                    == Some("library")
            {
                return Err(io::Error::other("injected database rollback failure"));
            }
            RealOperations.move_new(from, to)?;
            self.moved.borrow_mut().push(to.to_path_buf());
            Ok(())
        }
        fn sync_file(&self, path: &Path) -> io::Result<()> {
            self.step()?;
            RealOperations.sync_file(path)
        }
        fn sync_dir(&self, path: &Path) -> io::Result<()> {
            self.step()?;
            RealOperations.sync_dir(path)
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("stage");
        let library = root.path().join("library");
        fs::create_dir(&stage).unwrap();
        fs::create_dir(&library).unwrap();
        let source = stage.join("copy.db");
        fs::write(&source, b"book bytes").unwrap();
        fs::create_dir(stage.join("copy.pictures")).unwrap();
        fs::create_dir(stage.join("copy.research")).unwrap();
        fs::write(stage.join("copy.pictures/photo"), b"photo").unwrap();
        fs::write(stage.join("copy.research/note"), b"note").unwrap();
        let dest = library.join("018f9f07-2a85-7a20-9cb6-d476fd94cf04.db");
        (root, source, dest)
    }

    #[test]
    fn database_is_published_after_both_sidecars() {
        let (_root, source, dest) = fixture();
        let ops = Faults::new(None, false).checking_visibility();
        publish_with(&ops, &source, &dest).unwrap();
        let moved = ops.moved.borrow();
        assert!(moved[0].to_string_lossy().ends_with(".pictures"));
        assert!(moved[1].to_string_lossy().ends_with(".research"));
        assert_eq!(moved[2], dest);
        assert!(!source.exists());
        assert_eq!(fs::read(&dest).unwrap(), b"book bytes");
        assert_eq!(
            fs::read(sidecar(&dest, "pictures").unwrap().join("photo")).unwrap(),
            b"photo"
        );
    }

    #[test]
    fn collisions_preserve_existing_destination_and_restore_stages() {
        for suffix in ["pictures", "research", "db"] {
            let (_root, source, dest) = fixture();
            let occupied = if suffix == "db" {
                dest.clone()
            } else {
                sidecar(&dest, suffix).unwrap()
            };
            if suffix == "db" {
                fs::write(&occupied, b"existing").unwrap();
            } else {
                fs::create_dir(&occupied).unwrap();
                fs::write(occupied.join("existing"), b"existing").unwrap();
            }
            let error = publish(&source, &dest).unwrap_err();
            assert!(error.contains("destination already occupied"), "{error}");
            assert_eq!(fs::read(&source).unwrap(), b"book bytes");
            assert!(sidecar(&source, "pictures").unwrap().join("photo").exists());
            assert!(sidecar(&source, "research").unwrap().join("note").exists());
            if suffix == "db" {
                assert_eq!(fs::read(&occupied).unwrap(), b"existing");
            } else {
                assert_eq!(fs::read(occupied.join("existing")).unwrap(), b"existing");
            }
        }
    }

    #[test]
    fn occupied_database_is_refused_before_any_sidecar_move() {
        let (_root, source, dest) = fixture();
        fs::write(&dest, b"existing").unwrap();
        let ops = Faults::new(None, false);
        let error = publish_with(&ops, &source, &dest).unwrap_err();
        assert!(error.contains("destination already occupied"), "{error}");
        assert!(ops.moved.borrow().is_empty());
        assert!(!sidecar(&dest, "pictures").unwrap().exists());
        assert!(!sidecar(&dest, "research").unwrap().exists());
    }

    #[test]
    fn noncanonical_destination_uuid_is_refused_before_mutation() {
        let (_root, source, dest) = fixture();
        let uppercase = dest.with_file_name("018F9F07-2A85-7A20-9CB6-D476FD94CF04.db");
        let error = publish(&source, &uppercase).unwrap_err();
        assert!(error.contains("canonical UUID"), "{error}");
        assert!(source.exists());
        assert!(!uppercase.exists());
    }

    #[test]
    fn injected_sync_failure_rolls_back_only_moved_paths() {
        let (_root, source, dest) = fixture();
        // DB and two assets, three staged directories, first move, then sync.
        let error = publish_with(&Faults::new(Some(8), false), &source, &dest).unwrap_err();
        assert!(error.contains("sidecar sync"), "{error}");
        assert!(source.exists());
        assert!(sidecar(&source, "pictures").unwrap().exists());
        assert!(!sidecar(&dest, "pictures").unwrap().exists());
        assert!(!dest.exists());
    }

    #[test]
    fn injected_database_move_failure_restores_both_sidecars() {
        let (_root, source, dest) = fixture();
        // Six staged syncs; each of the two sidecar moves has two syncs.
        let error = publish_with(&Faults::new(Some(13), false), &source, &dest).unwrap_err();
        assert!(error.contains("exclusive move"), "{error}");
        assert_eq!(fs::read(&source).unwrap(), b"book bytes");
        assert!(sidecar(&source, "pictures").unwrap().join("photo").exists());
        assert!(sidecar(&source, "research").unwrap().join("note").exists());
        assert!(!sidecar(&dest, "pictures").unwrap().exists());
        assert!(!sidecar(&dest, "research").unwrap().exists());
        assert!(!dest.exists());
    }

    #[test]
    fn failed_rollback_names_retained_owned_destination() {
        let (_root, source, dest) = fixture();
        let error = publish_with(&Faults::new(Some(8), true), &source, &dest).unwrap_err();
        assert!(error.contains("rollback incomplete"), "{error}");
        assert!(error.contains("copy.pictures"), "{error}");
        assert!(sidecar(&dest, "pictures").unwrap().exists());
        assert!(source.exists());
        assert!(!dest.exists());
    }

    #[test]
    fn database_rollback_failure_retains_both_published_sidecars() {
        let (_root, source, dest) = fixture();
        // The DB has moved, then its parent sync fails. Reversing the DB
        // fails too, so both assets must remain alongside the visible DB.
        let ops = Faults::new(Some(14), false).failing_db_rollback();
        let error = publish_with(&ops, &source, &dest).unwrap_err();
        assert!(error.contains("rollback incomplete"), "{error}");
        assert!(
            error.contains("injected database rollback failure"),
            "{error}"
        );
        assert!(error.contains("pictures"), "{error}");
        assert!(error.contains("research"), "{error}");
        assert!(!source.exists());
        assert!(dest.exists());
        assert!(sidecar(&dest, "pictures").unwrap().join("photo").exists());
        assert!(sidecar(&dest, "research").unwrap().join("note").exists());
    }

    #[test]
    fn missing_or_unsafe_stage_is_refused_before_mutation() {
        let (_root, source, dest) = fixture();
        fs::remove_dir_all(sidecar(&source, "research").unwrap()).unwrap();
        assert!(publish(&source, &dest).is_err());
        assert!(source.exists());
        assert!(!dest.exists());
    }
}
