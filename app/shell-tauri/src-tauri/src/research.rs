use crate::store::knowledge;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const CHUNK_BYTES: usize = 64 * 1024;
pub const RESEARCH_SUFFIX: &str = ".research";

pub fn dir_for(project_db: &Path) -> PathBuf {
    let stem = project_db
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "project".into());
    project_db
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}{RESEARCH_SUFFIX}"))
}

fn hash_name(hash: &str) -> Result<&str, String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("research hash is malformed".into());
    }
    Ok(hash)
}

pub fn path_for(project_db: &Path, hash: &str) -> Result<PathBuf, String> {
    Ok(dir_for(project_db).join(hash_name(hash)?))
}

pub fn private_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("research directory is not a regular directory".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if meta.uid() != rustix::process::geteuid().as_raw()
                    || meta.permissions().mode() & 0o077 != 0
                {
                    return Err("research directory ownership or permissions are unsafe".into());
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(path)
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            fs::create_dir(path).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn regular_reader(path: &Path) -> Result<File, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("research source is not a regular file".into());
    }
    if meta.len() > knowledge::MAX_RESOURCE_BYTES {
        return Err(format!(
            "research file exceeds the {} byte limit",
            knowledge::MAX_RESOURCE_BYTES
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !opened.is_file() || opened.len() > knowledge::MAX_RESOURCE_BYTES {
        return Err("research source changed or exceeds its size limit".into());
    }
    Ok(file)
}

fn digest_file(path: &Path, max: u64) -> Result<(u64, String), String> {
    let mut file = regular_reader(path)?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; CHUNK_BYTES];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .ok_or("research byte count overflow")?;
        if bytes > max {
            return Err("research file grew beyond its byte limit".into());
        }
        digest.update(&buffer[..n]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

pub fn verify_original(project_db: &Path, hash: &str, expected_bytes: u64) -> Result<(), String> {
    if expected_bytes > knowledge::MAX_RESOURCE_BYTES {
        return Err("research size exceeds its limit".into());
    }
    let path = path_for(project_db, hash)?;
    let (bytes, actual_hash) = digest_file(&path, knowledge::MAX_RESOURCE_BYTES)?;
    if bytes != expected_bytes || actual_hash != hash {
        return Err("research original is missing or differs from its inventory".into());
    }
    Ok(())
}

pub fn copy_checked(
    source: &Path,
    destination: &Path,
    expected: Option<(&str, u64)>,
) -> Result<u64, String> {
    let mut input = regular_reader(source)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; CHUNK_BYTES];
        loop {
            let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            bytes = bytes
                .checked_add(n as u64)
                .ok_or("research byte count overflow")?;
            if bytes > knowledge::MAX_RESOURCE_BYTES {
                return Err("research file grew beyond its byte limit".into());
            }
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            digest.update(&buffer[..n]);
        }
        if let Some((hash, expected_bytes)) = expected {
            if bytes != expected_bytes || format!("{:x}", digest.finalize()) != hash {
                return Err("research original differs from its recorded hash or size".into());
            }
        }
        output.sync_all().map_err(|e| e.to_string())?;
        Ok(bytes)
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

/// Explicit import only. The source is opened for reading and never renamed,
/// truncated or written. A failed operation removes only its own staging file.
pub fn import_copy(
    project_db: &Path,
    source: &Path,
    commit: impl FnOnce(&str, u64, &str) -> Result<knowledge::Resource, String>,
) -> Result<knowledge::Resource, String> {
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("research source has no usable filename")?;
    let dir = dir_for(project_db);
    private_dir(&dir)?;
    let stage = dir.join(format!(".import-{}.partial", uuid::Uuid::now_v7()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut staged = options.open(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut from = regular_reader(source)?;
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; CHUNK_BYTES];
        loop {
            let n = from.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            bytes = bytes
                .checked_add(n as u64)
                .ok_or("research byte count overflow")?;
            if bytes > knowledge::MAX_RESOURCE_BYTES {
                return Err("research file grew beyond its byte limit".into());
            }
            staged.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            digest.update(&buffer[..n]);
        }
        if bytes == 0 {
            return Err("empty research files are not imported".into());
        }
        staged.sync_all().map_err(|e| e.to_string())?;
        let hash = format!("{:x}", digest.finalize());
        let destination = path_for(project_db, &hash)?;
        match fs::hard_link(&stage, &destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify_original(project_db, &hash, bytes)?;
            }
            Err(error) => return Err(format!("research original could not be published: {error}")),
        }
        crate::backup_bundle::sync_directory(&dir)?;
        commit(original_name, bytes, &hash)
    })();
    drop(staged);
    match fs::remove_file(&stage) {
        Ok(()) => result,
        Err(error) => Err(match result {
            Ok(_) => format!("research imported, but staging cleanup failed: {error}"),
            Err(original) => format!("{original}; research staging cleanup failed: {error}"),
        }),
    }
}

pub fn save_copy(
    project_db: &Path,
    hash: &str,
    bytes: u64,
    destination: &Path,
    publish: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    verify_original(project_db, hash, bytes)?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err("research copy destination already exists".into());
    }
    let parent = destination
        .parent()
        .ok_or("research copy destination has no parent")?;
    let stage = parent.join(format!(".research-copy-{}.partial", uuid::Uuid::now_v7()));
    let result = (|| {
        let mut input = regular_reader(&path_for(project_db, hash)?)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&stage).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut copied = 0u64;
        let mut buffer = [0u8; CHUNK_BYTES];
        loop {
            let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            copied = copied
                .checked_add(n as u64)
                .ok_or("research copy size overflow")?;
            if copied > bytes {
                return Err("research original changed during copy".into());
            }
            digest.update(&buffer[..n]);
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        if copied != bytes || format!("{:x}", digest.finalize()) != hash {
            return Err("research original changed during copy".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        publish(&stage, destination)?;
        crate::backup_bundle::sync_directory(parent)
    })();
    let cleanup = fs::remove_file(&stage);
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(e)) => Err(format!(
            "research copy saved, but staging cleanup failed: {e}"
        )),
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(cleanup)) => Err(format!("{e}; staging cleanup failed: {cleanup}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_publication_refusal_keeps_destination_absent_and_cleans_stage() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("book.db");
        let original = b"field notes";
        let hash = format!("{:x}", Sha256::digest(original));
        private_dir(&dir_for(&db)).unwrap();
        fs::write(path_for(&db, &hash).unwrap(), original).unwrap();
        let destination = root.path().join("exported.txt");
        let error = save_copy(
            &db,
            &hash,
            original.len() as u64,
            &destination,
            |stage, _| {
                assert!(stage.exists());
                Err("book switched before publication".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("book switched"));
        assert!(!destination.exists());
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".partial")));
    }
}
