//! Preserve bundle-owned native state when the desktop identifier changes.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const IDENTIFIER: &str = "com.usegarret.app";
const LEGACY_IDENTIFIER: &str = "cc.local.app";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Move {
    version: u32,
    identity: (u64, u64),
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
    }
}

fn identity(path: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = metadata(path)?.ok_or("native state is missing")?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(format!(
            "native state is not a regular file or directory: {}",
            path.display()
        ));
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn move_entry(parent: &Path, old_name: &str, new_name: &str) -> Result<(), String> {
    let old = parent.join(old_name);
    let new = parent.join(new_name);
    let journal = parent.join(format!(".{new_name}-identifier-migration.json"));
    let old_metadata = metadata(&old)?;
    let pending = metadata(&journal)?.is_some();
    if let Some(meta) = &old_metadata {
        if meta.file_type().is_symlink() {
            if fs::read_link(&old).map_err(|error| error.to_string())? != Path::new(new_name) {
                return Err(format!(
                    "native state link has an unexpected destination: {}",
                    old.display()
                ));
            }
            identity(&new)?;
            if !pending {
                return Ok(());
            }
        }
    }
    if old_metadata.is_none() && !pending {
        return Ok(());
    }
    let record = if pending {
        use std::io::Read;
        let mut file = crate::backup_bundle::open_regular_with_limit(&journal, 4096)
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let record: Move = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if record.version != 1 {
            return Err("unknown native state migration version".into());
        }
        record
    } else {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if metadata(&new)?.is_some() {
            return Err(format!(
                "both native state locations exist; neither was changed: {} and {}",
                old.display(),
                new.display()
            ));
        }
        let record = Move {
            version: 1,
            identity: identity(&old)?,
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&journal)
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec(&record).map_err(|error| error.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        crate::backup_bundle::sync_directory(parent)?;
        record
    };
    if metadata(&new)?.is_none() {
        if identity(&old)? != record.identity {
            return Err("native state changed after migration was prepared".into());
        }
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            &old,
            rustix::fs::CWD,
            &new,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|error| error.to_string())?;
        crate::backup_bundle::sync_directory(parent)?;
    }
    if identity(&new)? != record.identity {
        return Err("native state migration destination differs; files were retained".into());
    }
    if metadata(&old)?.is_none() {
        std::os::unix::fs::symlink(new_name, &old).map_err(|error| error.to_string())?;
        crate::backup_bundle::sync_directory(parent)?;
    } else if fs::read_link(&old).map_err(|error| error.to_string())? != Path::new(new_name) {
        return Err("native state migration source still exists; files were retained".into());
    }
    fs::remove_file(&journal).map_err(|error| error.to_string())?;
    crate::backup_bundle::sync_directory(parent)
}

pub(crate) fn prepare(home: &Path, temporary: &Path) -> Result<(), String> {
    if !home.is_absolute() || !temporary.is_absolute() {
        return Err(
            "native state migration requires absolute home and temporary directories".into(),
        );
    }
    for (directory, suffix) in [
        ("WebKit", ""),
        ("Caches", ""),
        ("HTTPStorages", ""),
        ("HTTPStorages", ".binarycookies"),
        ("Cookies", ".binarycookies"),
        ("Preferences", ".plist"),
        ("Saved Application State", ".savedState"),
    ] {
        move_entry(
            &home.join("Library").join(directory),
            &format!("{LEGACY_IDENTIFIER}{suffix}"),
            &format!("{IDENTIFIER}{suffix}"),
        )?;
    }
    move_entry(temporary, LEGACY_IDENTIFIER, IDENTIFIER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_state_preserves_bytes_and_legacy_access_and_repeats() {
        let temp = tempfile::tempdir().unwrap();
        let webkit = temp.path().join("Library/WebKit");
        let prefs = temp.path().join("Library/Preferences");
        let temporary = temp.path().join("temporary");
        fs::create_dir_all(temporary.join(LEGACY_IDENTIFIER).join("WebKit/MediaCache")).unwrap();
        fs::write(
            temporary
                .join(LEGACY_IDENTIFIER)
                .join("WebKit/MediaCache/media"),
            b"retained temporary media",
        )
        .unwrap();
        fs::create_dir_all(webkit.join(LEGACY_IDENTIFIER)).unwrap();
        fs::create_dir_all(&prefs).unwrap();
        fs::write(
            webkit.join(LEGACY_IDENTIFIER).join("localStorage"),
            b"retained web state",
        )
        .unwrap();
        fs::write(
            prefs.join("cc.local.app.plist"),
            b"retained native preferences",
        )
        .unwrap();
        prepare(temp.path(), &temporary).unwrap();
        prepare(temp.path(), &temporary).unwrap();
        for id in [LEGACY_IDENTIFIER, IDENTIFIER] {
            assert_eq!(
                fs::read(temporary.join(id).join("WebKit/MediaCache/media")).unwrap(),
                b"retained temporary media"
            );
            assert_eq!(
                fs::read(webkit.join(id).join("localStorage")).unwrap(),
                b"retained web state"
            );
            assert_eq!(
                fs::read(prefs.join(format!("{id}.plist"))).unwrap(),
                b"retained native preferences"
            );
        }
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
        let android: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.android.conf.json")).unwrap();
        assert_eq!(android["identifier"], LEGACY_IDENTIFIER);
    }

    #[test]
    fn native_state_resumes_after_rename_but_rejects_replaced_destination() {
        for replace in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let old = temp.path().join("old");
            let new = temp.path().join("new");
            fs::write(&old, b"state").unwrap();
            let record = Move {
                version: 1,
                identity: identity(&old).unwrap(),
            };
            fs::write(
                temp.path().join(".new-identifier-migration.json"),
                serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
            fs::rename(&old, &new).unwrap();
            if replace {
                fs::rename(&new, temp.path().join("retained")).unwrap();
                fs::write(&new, b"unrelated").unwrap();
                assert!(move_entry(temp.path(), "old", "new").is_err());
                assert_eq!(fs::read(&new).unwrap(), b"unrelated");
                assert!(!old.exists());
            } else {
                move_entry(temp.path(), "old", "new").unwrap();
                assert_eq!(fs::read(&old).unwrap(), b"state");
            }
        }
    }

    #[test]
    fn native_state_refuses_conflicts_and_unexpected_links() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("old"), b"old").unwrap();
        fs::write(temp.path().join("new"), b"new").unwrap();
        assert!(move_entry(temp.path(), "old", "new").is_err());
        assert_eq!(fs::read(temp.path().join("old")).unwrap(), b"old");
        assert_eq!(fs::read(temp.path().join("new")).unwrap(), b"new");
        std::os::unix::fs::symlink("new", temp.path().join("link")).unwrap();
        assert!(move_entry(temp.path(), "link", "other").is_err());
    }
}
