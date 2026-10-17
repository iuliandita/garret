use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path};

fn relative(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() || path.contains(['\\', ':', '%', '?', '#', '\0']) || path.starts_with('/') {
        return Err("unsafe Markdown asset path".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("unsafe Markdown asset path".into());
    }
    Ok(parts)
}

pub(crate) fn read_asset(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let parts = relative(path)?;
    let root = if root.as_os_str().is_empty() {
        Path::new(".")
    } else {
        root
    };
    #[cfg(unix)]
    let input = {
        use rustix::fs::{open, openat, Mode, OFlags};
        let directory = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut parent = open(root, directory, Mode::empty()).map_err(|e| e.to_string())?;
        for part in &parts[..parts.len() - 1] {
            parent = openat(&parent, *part, directory, Mode::empty()).map_err(|e| e.to_string())?;
        }
        let fd = openat(
            &parent,
            *parts.last().unwrap(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?;
        let file = fs::File::from(fd);
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > crate::pictures::MAX_PICTURE_BYTES {
            return Err("invalid Markdown asset file or size".into());
        }
        file
    };
    #[cfg(not(unix))]
    let input = {
        let mut location = root.to_path_buf();
        for part in &parts[..parts.len() - 1] {
            location.push(part);
            let metadata = fs::symlink_metadata(&location).map_err(|e| e.to_string())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("unsafe Markdown asset directory".into());
            }
        }
        location.push(parts.last().unwrap());
        let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
        if !location
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(canonical_root)
        {
            return Err("Markdown asset leaves selected package root".into());
        }
        crate::backup_bundle::open_regular_with_limit(&location, crate::pictures::MAX_PICTURE_BYTES)
            .map_err(|e| e.to_string())?
    };
    let mut bytes = Vec::new();
    input
        .take(crate::pictures::MAX_PICTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > crate::pictures::MAX_PICTURE_BYTES {
        return Err("Markdown asset exceeds limit".into());
    }
    Ok(bytes)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

pub(crate) fn publish(
    dest: &Path,
    bytes: &[u8],
    assets: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    publish_with(dest, bytes, assets, || Ok(()))
}

fn publish_with(
    dest: &Path,
    bytes: &[u8],
    assets: &BTreeMap<String, Vec<u8>>,
    before_markdown: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let root = dest
        .parent()
        .ok_or("missing Markdown destination directory")?;
    let root = if root.as_os_str().is_empty() {
        Path::new(".")
    } else {
        root
    };
    if fs::symlink_metadata(dest).is_ok() || fs::symlink_metadata(root.join("assets")).is_ok() {
        return Err("Markdown package destination or assets already exist".into());
    }
    for path in assets.keys() {
        let parts = relative(path)?;
        if parts.len() != 2 || parts[0] != "assets" {
            return Err("invalid publication asset path".into());
        }
    }
    let stage = root.join(format!(".markdown-stage-{}", uuid::Uuid::now_v7()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result: Result<(), String> = (|| {
        fs::create_dir(stage.join("assets")).map_err(|e| e.to_string())?;
        for (path, bytes) in assets {
            write_new(&stage.join(path), bytes)?;
        }
        write_new(&stage.join("manuscript.md"), bytes)?;
        fs::create_dir(root.join("assets")).map_err(|e| e.to_string())?;
        for path in assets.keys() {
            fs::hard_link(stage.join(path), root.join(path)).map_err(|e| e.to_string())?;
        }
        sync_directory(&root.join("assets"))?;
        before_markdown()?;
        fs::hard_link(stage.join("manuscript.md"), dest).map_err(|e| e.to_string())?;
        sync_directory(root)?;
        Ok(())
    })();
    if let Err(error) = result {
        return Err(format!(
            "{error}; Markdown stage retained at {}",
            stage.display()
        ));
    }
    fs::remove_dir_all(&stage).map_err(|e| {
        format!(
            "Markdown published; stage retained at {}: {e}",
            stage.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_confine_assets_and_publish_markdown_last_without_clobbering() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().join("selected");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(selected.join("assets")).unwrap();
        fs::write(
            selected.join("assets/image.png"),
            crate::figures::tests::PNG,
        )
        .unwrap();
        assert_eq!(
            read_asset(&selected, "assets/image.png").unwrap(),
            crate::figures::tests::PNG
        );
        fs::write(root.path().join("outside.png"), crate::figures::tests::PNG).unwrap();
        for path in [
            "../outside.png",
            "/outside.png",
            "assets/../../outside.png",
            "assets/./image.png",
            "assets//image.png",
            "https://host/image.png",
            "file:///image.png",
            "assets%2fimage.png",
            "assets\\image.png",
            "assets/image.png?x",
            "assets/missing.png",
        ] {
            assert!(read_asset(&selected, path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), selected.join("link")).unwrap();
            std::os::unix::fs::symlink(
                root.path().join("outside.png"),
                selected.join("assets/link.png"),
            )
            .unwrap();
            assert!(read_asset(&selected, "link/outside.png").is_err());
            assert!(read_asset(&selected, "assets/link.png").is_err());
            std::os::unix::fs::symlink(&selected, root.path().join("selected-link")).unwrap();
            assert!(read_asset(&root.path().join("selected-link"), "assets/image.png").is_err());
        }
        let oversized = fs::File::create(selected.join("assets/oversized.png")).unwrap();
        oversized
            .set_len(crate::pictures::MAX_PICTURE_BYTES + 1)
            .unwrap();
        assert!(read_asset(&selected, "assets/oversized.png").is_err());
        let assets = BTreeMap::from([(
            "assets/hash.png".into(),
            crate::figures::tests::PNG.to_vec(),
        )]);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.md");
        let error = publish_with(&dest, b"book", &assets, || {
            assert!(!dest.exists());
            assert_eq!(
                fs::read(out.path().join("assets/hash.png")).unwrap(),
                crate::figures::tests::PNG
            );
            fs::write(&dest, "external work").unwrap();
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("stage retained"));
        assert_eq!(fs::read_to_string(&dest).unwrap(), "external work");
        let stages: Vec<_> = fs::read_dir(out.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".markdown-stage-")
            })
            .collect();
        assert_eq!(stages.len(), 1);
        assert_eq!(
            fs::read(stages[0].path().join("manuscript.md")).unwrap(),
            b"book"
        );
        assert!(publish(&dest, b"overwrite", &assets).is_err());
        let another = out.path().join("another.md");
        assert!(publish(&another, b"book", &assets).is_err());
        assert!(!another.exists());
        assert_eq!(
            fs::read_dir(out.path())
                .unwrap()
                .flatten()
                .filter(|e| e
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".markdown-stage-"))
                .count(),
            1
        );
        let clean = tempfile::tempdir().unwrap();
        for path in [
            "other/image.png",
            "assets/nested/image.png",
            "assets/../image.png",
        ] {
            let invalid = BTreeMap::from([(path.into(), crate::figures::tests::PNG.to_vec())]);
            assert!(publish(&clean.path().join("invalid.md"), b"book", &invalid).is_err());
            assert_eq!(fs::read_dir(clean.path()).unwrap().count(), 0);
        }
        publish(&clean.path().join("book.md"), b"book", &assets).unwrap();
        assert_eq!(fs::read_dir(clean.path()).unwrap().count(), 2);
    }
}
