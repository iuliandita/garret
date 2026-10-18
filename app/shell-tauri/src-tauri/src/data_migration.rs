//! Move desktop application storage without creating a second writable profile.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::path::{Component, Path};

pub(crate) const LEGACY_DIR: &str = "cc.local.app";
const INTENT: &str = ".garret-data-migration.json";
const CLI_PENDING: &str = "reopen garret to set aside an unused leftover folder";
const STAGE: &str = ".garret-data-migration";
const RECORD: &str = ".migration-from-cc.local.app.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    source_identity: Option<(u64, u64)>,
    settings_before: Option<String>,
    settings_after: Option<String>,
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
    }
}

fn real_directory(path: &Path) -> Result<bool, String> {
    let Some(meta) = metadata(path)? else {
        return Ok(false);
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(format!(
            "application data is not a regular directory: {}",
            path.display()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "application data is a reparse point: {}",
                path.display()
            ));
        }
    }
    Ok(true)
}

fn bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = crate::backup_bundle::open_regular_with_limit(path, 16 * 1024 * 1024)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut body = Vec::new();
    file.read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    Ok(body)
}

fn digest(body: &[u8]) -> String {
    format!("{:x}", Sha256::digest(body))
}

fn write_new(path: &Path, body: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    #[cfg(windows)]
    crate::privacy_windows_file::restrict(path).map_err(|error| error.to_string())?;
    file.write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

fn move_new(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let wide = |path: &Path| -> Result<Vec<u16>, String> {
            let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
            if value.contains(&0) {
                return Err("application data path contains NUL".into());
            }
            value.push(0);
            Ok(value)
        };
        let from = wide(from)?;
        let to = wide(to)?;
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

fn remap(value: &mut Value, old: &Path, new: &Path, home: Option<&Path>) {
    let Some(raw) = value.as_str() else { return };
    let expanded = home.map_or_else(
        || raw.to_owned(),
        |home| crate::projects::expand_home(raw, home),
    );
    let path = Path::new(&expanded);
    if path.components().any(|part| part == Component::ParentDir) {
        return;
    }
    if let Ok(rest) = path.strip_prefix(old) {
        let moved = new.join(rest).to_string_lossy().into_owned();
        *value = Value::String(home.map_or_else(
            || moved.clone(),
            |home| crate::projects::contract_home(&moved, home),
        ));
    }
}

fn source_identity(root: &Path) -> Result<Option<(u64, u64)>, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(root).map_err(|error| error.to_string())?;
        Ok(Some((metadata.dev(), metadata.ino())))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let file = OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0007)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(root)
            .map_err(|error| error.to_string())?;
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if information.dwFileAttributes & 0x400 != 0 {
            return Err("application data identity is a reparse point".into());
        }
        Ok(Some((
            u64::from(information.dwVolumeSerialNumber),
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        )))
    }
}

pub(crate) fn refusal(data_home: &Path, detail: &str) -> String {
    let new = data_home.join(crate::APP_DIR);
    let old = data_home.join(LEGACY_DIR);
    let locale = bytes(&new.join("settings.json"))
        .or_else(|_| bytes(&old.join("settings.json")))
        .ok()
        .and_then(|body| serde_json::from_slice::<crate::projects::Settings>(&body).ok())
        .map(|settings| settings.locale)
        .unwrap_or_default();
    if detail == CLI_PENDING {
        return locale
            .strings()
            .t("startup.data_migration_pending")
            .to_owned();
    }
    let strings = locale.strings();
    let new_missing = matches!(metadata(&new), Ok(None));
    let old_count = book_count(&old);
    let new_count = book_count(&new);
    let count = |value| match value {
        Some(0) => strings.t("startup.data_migration_books_none").to_owned(),
        Some(1) => strings.t("startup.data_migration_books_one").to_owned(),
        Some(n) => strings.f(
            "startup.data_migration_books_many",
            &[("count", &n.to_string())],
        ),
        None => strings.t("startup.data_migration_books_unknown").to_owned(),
    };
    let unchanged = real_directory(&old).unwrap_or(false)
        && real_directory(&new).unwrap_or(false)
        && !migration_started(data_home);
    let location = match (old_count, new_count) {
        _ if new_missing => String::new(),
        (Some(n), Some(0)) if n > 0 => strings.t("startup.data_migration_location_old"),
        (Some(0), Some(n)) if n > 0 => strings.t("startup.data_migration_location_new"),
        _ => String::new(),
    };
    let location = if location.is_empty() {
        String::new()
    } else {
        format!("\n\n{location}")
    };
    let guidance = strings.f(
        if new_missing {
            "startup.data_migration_single"
        } else {
            "startup.data_migration"
        },
        &[
            (
                "status",
                &locale.strings().t(if unchanged {
                    "startup.data_migration_unchanged"
                } else {
                    "startup.data_migration_preserved"
                }),
            ),
            ("old", &old.to_string_lossy()),
            ("new", &new.to_string_lossy()),
            ("location", &location),
            ("old_count", &count(old_count)),
            ("new_count", &count(new_count)),
        ],
    );
    format!("{guidance}\n{detail}")
}

fn migration_started(data_home: &Path) -> bool {
    if metadata(&data_home.join(INTENT)).map_or(true, |value| value.is_some())
        || metadata(&data_home.join(STAGE)).map_or(true, |value| value.is_some())
        || metadata(&data_home.join(crate::APP_DIR).join(RECORD))
            .map_or(true, |value| value.is_some())
    {
        return true;
    }
    fs::read_dir(data_home).map_or(true, |entries| {
        entries.into_iter().any(|entry| {
            entry.map_or(true, |entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".garret.set-aside-")
                    || entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("garret.set-aside-")
            })
        })
    })
}

fn book_paths(value: &Value) -> Result<Vec<&str>, String> {
    let mut paths = Vec::new();
    if let Some(value) = value.get("last_project").filter(|v| !v.is_null()) {
        paths.push(value.as_str().ok_or("unrecognized last book path")?);
    }
    for field in ["books", "recent", "book_locations"] {
        if let Some(entries) = value.get(field) {
            for entry in entries.as_array().ok_or("unrecognized book list")? {
                let path = if field == "books" {
                    entry
                } else {
                    entry.get("path").ok_or("missing book path")?
                };
                paths.push(path.as_str().ok_or("unrecognized book path")?);
            }
        }
    }
    Ok(paths)
}

fn expanded_path(raw: &str) -> Result<PathBuf, String> {
    let path = if raw == "~" || raw.starts_with("~/") {
        let home = crate::projects::home_dir().ok_or("cannot determine the home directory")?;
        PathBuf::from(crate::projects::expand_home(raw, &home))
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err("book path is not an unambiguous absolute path".into());
    }
    Ok(path)
}

fn book_count(root: &Path) -> Option<usize> {
    let mut paths = std::collections::BTreeSet::new();
    if metadata(&root.join("settings.json")).ok()?.is_some() {
        let value: Value =
            serde_json::from_slice(&bytes(&root.join("settings.json")).ok()?).ok()?;
        for raw in book_paths(&value).ok()? {
            let path = expanded_path(raw).ok()?;
            match fs::canonicalize(&path) {
                Ok(path) if fs::metadata(&path).ok()?.is_file() => {
                    paths.insert(path);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return None,
            }
        }
    }
    let projects = root.join("projects");
    if real_directory(&projects).ok()? {
        for entry in fs::read_dir(projects).ok()? {
            let path = entry.ok()?.path();
            if path.extension().is_some_and(|ext| ext == "db")
                && fs::metadata(&path).ok()?.is_file()
            {
                paths.insert(fs::canonicalize(&path).ok()?);
            }
        }
    }
    Some(paths.len())
}

fn existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    loop {
        match fs::canonicalize(current) {
            Ok(path) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if metadata(current)?.is_some() {
                    return Err("book ancestor exists but cannot be resolved".into());
                }
                current = current
                    .parent()
                    .ok_or("book path has no resolvable ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn safe_temporary_directory(root: &Path) -> Result<Option<PathBuf>, String> {
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    let home = crate::projects::home_dir()
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or("cannot determine the home directory")?;
    let home = fs::canonicalize(home).map_err(|error| error.to_string())?;
    let data_home = fs::canonicalize(root.parent().ok_or("missing data home")?)
        .map_err(|error| error.to_string())?;
    Ok((!home.starts_with(&temp) && !data_home.starts_with(&temp)).then_some(temp))
}

fn harmless_settings(root: &Path) -> Result<bool, String> {
    let value: Value = serde_json::from_slice(&bytes(&root.join("settings.json"))?)
        .map_err(|error| error.to_string())?;
    let object = value.as_object().ok_or("settings must be an object")?;
    let known = serde_json::to_value(crate::projects::Settings::default())
        .map_err(|error| error.to_string())?;
    if object.keys().any(|key| known.get(key).is_none()) {
        return Ok(false);
    }
    for field in [
        "encrypted_backup_dir",
        "mirrored",
        "mirrored_book_ids",
        "protection_claims",
    ] {
        if let Some(value) = object.get(field) {
            if !value.is_null() && !value.as_array().is_some_and(Vec::is_empty) {
                return Ok(false);
            }
        }
    }
    let Some(temp) = safe_temporary_directory(root)? else {
        return Ok(false);
    };
    for raw in book_paths(&value)? {
        let path = expanded_path(raw)?;
        match fs::canonicalize(&path) {
            Ok(path) if !path.starts_with(&temp) => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !existing_ancestor(&path)?.starts_with(&temp) {
                    return Ok(false);
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(true)
}

fn harmless_folder(root: &Path) -> Result<bool, String> {
    if safe_temporary_directory(root)?.is_none() {
        return Ok(false);
    }
    validate_tree(root, 0)?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let meta = metadata(&path)?.ok_or("leftover folder changed during inspection")?;
        let allowed = if meta.is_dir() && path.file_name().is_some_and(|name| name == "spell") {
            fs::read_dir(&path)
                .map_err(|error| error.to_string())?
                .next()
                .transpose()
                .map_err(|error| error.to_string())?
                .is_none()
        } else if meta.is_dir() {
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some(
                    "WebKit"
                        | "webkitgtk"
                        | "WebKitCache"
                        | "CacheStorage"
                        | "mediakeys"
                        | "storage"
                        | "WebView2"
                        | "EBWebView"
                        | "GPUCache"
                        | "Cache"
                        | "Code Cache"
                        | "Local Storage"
                        | "IndexedDB"
                        | "Session Storage"
                )
            ) && cache_only(&path)?
        } else {
            match path.file_name().and_then(|name| name.to_str()) {
                Some("settings.json") => harmless_settings(root)?,
                Some("instance.lock" | "focus.request") => true,
                Some(
                    "hsts-storage.sqlite" | "hsts-storage.sqlite-wal" | "hsts-storage.sqlite-shm",
                ) => true,
                _ => false,
            }
        };
        if !allowed {
            return Ok(false);
        }
    }
    Ok(true)
}

fn cache_only(root: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("unrecognized cache filename")?
            .to_ascii_lowercase();
        if [
            ".db",
            ".db-wal",
            ".db-shm",
            ".sqlite",
            ".sqlite3",
            ".sqlite-wal",
            ".sqlite-shm",
            ".sqlite3-wal",
            ".sqlite3-shm",
            ".localstorage",
            ".localstorage-wal",
            ".localstorage-shm",
        ]
        .iter()
        .any(|ending| name.ends_with(*ending))
        {
            return Ok(false);
        }
        if metadata(&path)?.ok_or("cache disappeared")?.is_dir() && !cache_only(&path)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn set_aside(data_home: &Path) -> Result<(), String> {
    let new = data_home.join(crate::APP_DIR);
    if !data_home.is_absolute() || !harmless_folder(&new)? {
        return Err("both application data folders need to be kept".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let stamp = crate::recovery::point_id(i64::try_from(now).map_err(|error| error.to_string())?);
    for ordinal in 0..1000 {
        let name = format!("{}.set-aside-{stamp}-{ordinal}", crate::APP_DIR);
        let destination = data_home.join(&name);
        let receipt = data_home.join(format!(".{name}.json"));
        if metadata(&destination)?.is_some() || metadata(&receipt)?.is_some() {
            continue;
        }
        let identity = source_identity(&new)?;
        write_new(
            &receipt,
            &serde_json::to_vec(&serde_json::json!({
                "version": 1, "source": crate::APP_DIR, "destination": name,
                "source_identity": identity,
            }))
            .map_err(|error| error.to_string())?,
        )?;
        crate::backup_bundle::sync_directory(data_home)?;
        if source_identity(&new)? != identity || !harmless_folder(&new)? {
            return Err("leftover folder changed before it could be set aside".into());
        }
        move_new(&new, &destination)?;
        crate::backup_bundle::sync_directory(data_home)?;
        eprintln!("An unused leftover folder was set aside as {name}.");
        return Ok(());
    }
    Err("cannot reserve a name for the leftover folder".into())
}

fn prepare_settings(
    root: &Path,
    old: &Path,
    new: &Path,
    home: Option<&Path>,
) -> Result<Intent, String> {
    let path = root.join("settings.json");
    if metadata(&path)?.is_none() {
        return Ok(Intent {
            version: 1,
            source_identity: source_identity(root)?,
            settings_before: None,
            settings_after: None,
        });
    }
    let original = bytes(&path)?;
    let mut value: Value = serde_json::from_slice(&original)
        .map_err(|error| format!("settings migration refused: {error}"))?;
    if !value.is_object() {
        return Err("settings migration requires a JSON object".into());
    }
    let _: crate::projects::Settings = serde_json::from_value(value.clone())
        .map_err(|error| format!("settings migration refused: {error}"))?;
    for field in ["last_project", "new_book_dir", "encrypted_backup_dir"] {
        if let Some(path) = value.get_mut(field) {
            remap(path, old, new, home);
        }
    }
    if let Some(books) = value.get_mut("books").and_then(Value::as_array_mut) {
        for path in books {
            remap(path, old, new, home);
        }
    }
    for field in ["book_locations", "recent"] {
        if let Some(entries) = value.get_mut(field).and_then(Value::as_array_mut) {
            for entry in entries {
                if let Some(path) = entry.get_mut("path") {
                    remap(path, old, new, home);
                }
            }
        }
    }
    Ok(Intent {
        version: 1,
        source_identity: source_identity(root)?,
        settings_before: Some(digest(&original)),
        settings_after: Some(serde_json::to_string(&value).map_err(|error| error.to_string())?),
    })
}

fn install_settings(root: &Path, intent: &Intent) -> Result<(), String> {
    let path = root.join("settings.json");
    match (&intent.settings_before, &intent.settings_after) {
        (None, None) if metadata(&path)?.is_none() => Ok(()),
        (Some(before), Some(after)) => {
            let current = bytes(&path)?;
            if current == after.as_bytes() {
                return Ok(());
            }
            if digest(&current) != *before {
                return Err("settings changed during application data migration".into());
            }
            let temp = root.join(".settings-migration.tmp");
            if metadata(&temp)?.is_some() {
                if bytes(&temp)? != after.as_bytes() {
                    return Err("unfinished settings migration differs; files were retained".into());
                }
            } else {
                write_new(&temp, after.as_bytes())?;
            }
            fs::rename(&temp, &path).map_err(|error| error.to_string())?;
            crate::backup_bundle::sync_directory(root)
        }
        _ => Err("invalid settings migration record".into()),
    }
}

fn validate_tree(root: &Path, depth: usize) -> Result<(), String> {
    if depth > 128 {
        return Err("application data nesting is too deep to move safely".into());
    }
    real_directory(root)?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let meta = metadata(&path)?.ok_or("application data changed during inspection")?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            validate_tree(&path, depth + 1)?;
        } else {
            let _ = crate::backup_bundle::open_regular_with_limit(&path, u64::MAX).map_err(
                |error| {
                    format!(
                        "application data migration refused {}: {error}",
                        path.display()
                    )
                },
            )?;
        }
    }
    Ok(())
}

fn validate_profile(root: &Path) -> Result<(), String> {
    validate_tree(root, 0)?;
    crate::privacy::validate_migration_record(&root.join("privacy.json"))?;
    let vault = root.join("identities.json");
    if metadata(&vault)?.is_some() {
        let vault: crate::identity::Vault = serde_json::from_slice(&bytes(&vault)?)
            .map_err(|error| format!("identity vault migration refused: {error}"))?;
        if vault.version > crate::identity::VAULT_VERSION {
            return Err("identity vault version is newer than this application".into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn legacy_alias(old: &Path, new: &Path) -> Result<bool, String> {
    match metadata(old)? {
        Some(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(old).map_err(|error| error.to_string())? != Path::new(crate::APP_DIR)
                || !real_directory(new)?
            {
                return Err(
                    "the legacy application data link has an unexpected destination".into(),
                );
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub(crate) fn check_cli(data_home: &Path) -> Result<(), String> {
    let old = data_home.join(LEGACY_DIR);
    let new = data_home.join(crate::APP_DIR);
    if metadata(&data_home.join(INTENT))?.is_some() {
        return Err("application data migration is unfinished; reopen garret to finish preparing its library".into());
    }
    #[cfg(unix)]
    if legacy_alias(&old, &new)? {
        return Ok(());
    }
    let old_exists = real_directory(&old)?;
    let new_exists = real_directory(&new)?;
    #[cfg(windows)]
    {
        return check_copy_cli(data_home);
    }
    #[cfg(unix)]
    if old_exists {
        if new_exists && unused_destination(data_home, &old, &new)? {
            return Err(CLI_PENDING.into());
        }
        return Err(if new_exists {
            "both application data folders need to be kept"
        } else {
            "application data must be moved first; close older garret versions and reopen garret"
        }
        .into());
    }
    let _ = new_exists;
    Ok(())
}

fn unused_destination(data_home: &Path, old: &Path, new: &Path) -> Result<bool, String> {
    if !data_home.is_absolute() || !harmless_folder(new)? {
        return Ok(false);
    }
    validate_profile(old)?;
    prepare_settings(old, old, new, crate::projects::home_dir().as_deref())?;
    Ok(true)
}

#[cfg(any(windows, test))]
fn copy_set_aside_candidate(data_home: &Path, old: &Path, new: &Path) -> Result<bool, String> {
    Ok(has_payload(old)?
        && completed_record(new)?.is_none()
        && unused_destination(data_home, old, new)?)
}

#[cfg(any(windows, test))]
fn check_copy_cli(data_home: &Path) -> Result<(), String> {
    let old = data_home.join(LEGACY_DIR);
    let new = data_home.join(crate::APP_DIR);
    if real_directory(&old)? && has_payload(&old)? {
        if real_directory(&new)? {
            if let Some(record) = completed_record(&new)? {
                return verify_completed(&old, &new, &record);
            }
            if copy_set_aside_candidate(data_home, &old, &new)? {
                return Err(CLI_PENDING.into());
            }
            return Err("both application data folders need to be kept".into());
        }
        return Err(
            "application data must be moved first; close older garret versions and reopen garret"
                .into(),
        );
    }
    if metadata(&data_home.join(STAGE))?.is_some() {
        return Err("application data migration is unfinished; reopen garret to finish preparing its library".into());
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn prepare(data_home: &Path) -> Result<(), String> {
    let old = data_home.join(LEGACY_DIR);
    let new = data_home.join(crate::APP_DIR);
    let journal = data_home.join(INTENT);
    let intent = if metadata(&journal)?.is_some() {
        let intent: Intent = serde_json::from_slice(&bytes(&journal)?)
            .map_err(|error| format!("invalid application data migration record: {error}"))?;
        if intent.version != 1 {
            return Err("unknown application data migration version".into());
        }
        intent
    } else {
        if legacy_alias(&old, &new)? {
            return Ok(());
        }
        let old_exists = real_directory(&old)?;
        let new_exists = real_directory(&new)?;
        if !old_exists {
            return Ok(());
        }
        if new_exists && !unused_destination(data_home, &old, &new)? {
            return Err("both application data folders need to be kept".into());
        }
        if !data_home.is_absolute() {
            return Err("application data migration requires an absolute data home".into());
        }
        validate_profile(&old)?;
        let intent = prepare_settings(&old, &old, &new, crate::projects::home_dir().as_deref())?;
        write_new(
            &journal,
            &serde_json::to_vec(&intent).map_err(|error| error.to_string())?,
        )?;
        crate::backup_bundle::sync_directory(data_home)?;
        intent
    };
    if !legacy_alias(&old, &new)? && real_directory(&old)? {
        // Recheck the saved settings before the only operation that moves source data.
        let current = prepare_settings(&old, &old, &new, crate::projects::home_dir().as_deref())?;
        if current.source_identity != intent.source_identity
            || current.settings_before != intent.settings_before
            || current.settings_after != intent.settings_after
        {
            return Err("settings changed after application data migration was prepared".into());
        }
        if real_directory(&new)? {
            set_aside(data_home)?;
        }
        move_new(&old, &new)?;
        crate::backup_bundle::sync_directory(data_home)?;
    }
    if !real_directory(&new)? {
        return Err("application data migration source and destination are missing".into());
    }
    if source_identity(&new)? != intent.source_identity {
        return Err(
            "the migration destination is not the original application data directory".into(),
        );
    }
    install_settings(&new, &intent)?;
    if !legacy_alias(&old, &new)? {
        std::os::unix::fs::symlink(crate::APP_DIR, &old)
            .map_err(|error| format!("cannot retain the legacy application data link: {error}"))?;
        crate::backup_bundle::sync_directory(data_home)?;
    }
    fs::remove_file(&journal).map_err(|error| error.to_string())?;
    crate::backup_bundle::sync_directory(data_home)
}

#[cfg(any(windows, test))]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyRecord {
    version: u32,
    destination_identity: Option<(u64, u64)>,
    intent: Intent,
    files: Vec<(PathBuf, String)>,
}

#[cfg(any(windows, test))]
fn has_payload(root: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let name = entry.map_err(|error| error.to_string())?.file_name();
        if name != "instance.lock" && name != "focus.request" {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(any(windows, test))]
fn file_digest(path: &Path) -> Result<String, String> {
    let mut file =
        crate::backup_bundle::open_regular_with_limit(path, u64::MAX).map_err(str::to_owned)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(any(windows, test))]
fn copy_tree(
    source: &Path,
    destination: &Path,
    relative: &Path,
    files: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    if relative.components().count() > 128 {
        return Err("application data nesting is too deep to copy safely".into());
    }
    for entry in fs::read_dir(source.join(relative)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let rel = relative.join(entry.file_name());
        if relative.as_os_str().is_empty()
            && ["instance.lock", "focus.request"]
                .iter()
                .any(|name| rel == Path::new(name))
        {
            continue;
        }
        let from = source.join(&rel);
        let to = destination.join(&rel);
        if real_directory_or_file(&from)? {
            fs::create_dir(&to).map_err(|error| error.to_string())?;
            #[cfg(windows)]
            crate::privacy_windows_file::restrict(&to).map_err(|error| error.to_string())?;
            fs::set_permissions(
                &to,
                fs::metadata(&from)
                    .map_err(|error| error.to_string())?
                    .permissions(),
            )
            .map_err(|error| error.to_string())?;
            files.push((rel.clone(), "directory".into()));
            copy_tree(source, destination, &rel, files)?;
            crate::backup_bundle::sync_directory(&to)?;
        } else {
            let mut input = crate::backup_bundle::open_regular_with_limit(&from, u64::MAX)
                .map_err(str::to_owned)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&to)
                .map_err(|error| error.to_string())?;
            #[cfg(windows)]
            crate::privacy_windows_file::restrict(&to).map_err(|error| error.to_string())?;
            std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
            output
                .set_permissions(
                    input
                        .metadata()
                        .map_err(|error| error.to_string())?
                        .permissions(),
                )
                .map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            let hash = file_digest(&to)?;
            if file_digest(&from)? != hash {
                return Err(
                    "application data changed while it was copied; both copies were retained"
                        .into(),
                );
            }
            files.push((rel, hash));
        }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn real_directory_or_file(path: &Path) -> Result<bool, String> {
    let meta = metadata(path)?.ok_or("application data disappeared")?;
    if meta.is_dir() {
        real_directory(path)
    } else {
        Ok(false)
    }
}

#[cfg(any(windows, test))]
fn completed_record(root: &Path) -> Result<Option<CopyRecord>, String> {
    let path = root.join(RECORD);
    if metadata(&path)?.is_none() {
        return Ok(None);
    }
    let record: CopyRecord = serde_json::from_slice(&bytes(&path)?)
        .map_err(|error| format!("invalid application data copy record: {error}"))?;
    if record.version != 1
        || record.intent.version != 1
        || record.files.iter().any(|(path, _)| {
            path.as_os_str().is_empty()
                || path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
        })
    {
        return Err("unknown or unsafe application data copy record".into());
    }
    Ok(Some(record))
}

#[cfg(any(windows, test))]
fn inventory(
    root: &Path,
    relative: &Path,
    exclude_record: bool,
    out: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    if relative.components().count() > 128 {
        return Err("application data nesting is too deep to inspect safely".into());
    }
    for entry in fs::read_dir(root.join(relative)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let rel = relative.join(entry.file_name());
        if relative.as_os_str().is_empty()
            && (["instance.lock", "focus.request"]
                .iter()
                .any(|name| rel == Path::new(name))
                || (exclude_record && rel == Path::new(RECORD)))
        {
            continue;
        }
        if real_directory_or_file(&root.join(&rel))? {
            out.push((rel.clone(), "directory".into()));
            inventory(root, &rel, exclude_record, out)?;
        } else {
            out.push((rel.clone(), file_digest(&root.join(&rel))?));
        }
    }
    out.sort();
    Ok(())
}

#[cfg(any(windows, test))]
fn verify_completed(old: &Path, new: &Path, record: &CopyRecord) -> Result<(), String> {
    if source_identity(old)? != record.intent.source_identity
        || source_identity(new)? != record.destination_identity
        || record.destination_identity.is_none()
    {
        return Err("application data migration record belongs to different directories; both were retained".into());
    }
    let mut source = Vec::new();
    inventory(old, Path::new(""), false, &mut source)?;
    let mut expected = record.files.clone();
    expected.sort();
    if source != expected {
        return Err(
            "legacy application data changed after migration; both copies were retained".into(),
        );
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn verify_copy(old: &Path, stage: &Path, record: &CopyRecord) -> Result<(), String> {
    validate_tree(stage, 0)?;
    verify_completed(old, stage, record)?;
    let mut expected = record.files.clone();
    expected.sort();
    let mut source = Vec::new();
    inventory(old, Path::new(""), false, &mut source)?;
    if source != expected {
        return Err("legacy application data changed; both copies were retained".into());
    }
    for (relative, hash) in &mut expected {
        if relative.as_path() == Path::new("settings.json") {
            if let Some(body) = &record.intent.settings_after {
                *hash = digest(body.as_bytes());
            }
        }
    }
    let mut copied = Vec::new();
    inventory(stage, Path::new(""), true, &mut copied)?;
    if copied != expected {
        return Err("copied application data did not verify; both copies were retained".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn prepare_copy(data_home: &Path, guard: &crate::instance_file::Guard) -> Result<(), String> {
    let old = data_home.join(LEGACY_DIR);
    let new = data_home.join(crate::APP_DIR);
    let stage = data_home.join(STAGE);
    real_directory(&old)?;
    if real_directory(&new)? {
        if copy_set_aside_candidate(data_home, &old, &new)? {
            set_aside(data_home)?;
        } else {
            if has_payload(&old)? {
                let record = completed_record(&new)?
                    .ok_or("both application data folders need to be kept")?;
                if !guard.migrated()? {
                    return Err("both application data folders need to be kept".into());
                }
                verify_completed(&old, &new, &record)?;
            }
            guard.mark_migrated()?;
            return Ok(());
        }
    }
    if !has_payload(&old)? {
        if metadata(&stage)?.is_some() {
            return Err("unfinished application data copy was retained for inspection".into());
        }
        guard.mark_migrated()?;
        return Ok(());
    }
    validate_profile(&old)?;
    let record = if real_directory(&stage)? {
        completed_record(&stage)?
            .ok_or("unfinished application data copy was retained for inspection")?
    } else {
        let intent = prepare_settings(&old, &old, &new, crate::projects::home_dir().as_deref())?;
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&stage).map_err(|error| error.to_string())?;
        #[cfg(windows)]
        crate::privacy_windows_file::restrict(&stage).map_err(|error| error.to_string())?;
        let mut record = CopyRecord {
            version: 1,
            destination_identity: source_identity(&stage)?,
            intent,
            files: Vec::new(),
        };
        copy_tree(&old, &stage, Path::new(""), &mut record.files)?;
        install_settings(&stage, &record.intent)?;
        write_new(
            &stage.join(RECORD),
            &serde_json::to_vec(&record).map_err(|error| error.to_string())?,
        )?;
        crate::backup_bundle::sync_directory(&stage)?;
        record
    };
    verify_copy(&old, &stage, &record)?;
    #[cfg(windows)]
    restrict_copy_tree(&stage, 0)?;
    guard.mark_migrated()?;
    move_new(&stage, &new)?;
    crate::backup_bundle::sync_directory(data_home)
}

#[cfg(windows)]
fn restrict_copy_tree(root: &Path, depth: usize) -> Result<(), String> {
    if depth > 128 {
        return Err("application data nesting is too deep to secure safely".into());
    }
    real_directory(root)?;
    crate::privacy_windows_file::restrict(root).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if real_directory_or_file(&path)? {
            restrict_copy_tree(&path, depth + 1)?;
        } else {
            let _ = crate::backup_bundle::open_regular_with_limit(&path, u64::MAX)
                .map_err(str::to_owned)?;
            crate::privacy_windows_file::restrict(&path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn prepare(data_home: &Path, guard: &crate::instance_file::Guard) -> Result<(), String> {
    prepare_copy(data_home, guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn tempdir() -> std::io::Result<tempfile::TempDir> {
        tempfile::Builder::new()
            .prefix("migration-")
            .tempdir_in(crate::projects::home_dir().unwrap())
    }

    fn isolated_case(test: &str, home: &Path, data: &Path, temp: &Path) {
        for path in [home, data, temp] {
            fs::create_dir_all(path).unwrap();
        }
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("data_migration::tests::{test}"),
                "--nocapture",
            ])
            .env("HOME", home)
            .env("XDG_DATA_HOME", data)
            .env("TMPDIR", temp)
            .env("TMP", temp)
            .env("TEMP", temp)
            .env("GARRET_MIGRATION_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    fn isolated_temporary_directory(test: &str) -> bool {
        if std::env::var_os("GARRET_MIGRATION_CHILD").is_some() {
            return false;
        }
        let root = tempdir().unwrap();
        isolated_case(
            test,
            &root.path().join("home"),
            &root.path().join("data"),
            &root.path().join("temporary"),
        );
        true
    }

    #[test]
    fn missing_books_are_classified_on_both_paths() {
        if isolated_temporary_directory("missing_books_are_classified_on_both_paths") {
            return;
        }
        let gone = std::env::temp_dir().join("gone/x.db");
        let outside = if cfg!(windows) {
            PathBuf::from(r"C:\mnt\usb\x.db")
        } else {
            PathBuf::from("/mnt/usb/x.db")
        };
        assert!(!gone.exists() && !outside.exists());
        for copy in modes() {
            for (row, settings, allowed) in [
                (
                    "temporary",
                    json!({"books":[gone], "last_project":gone, "book_locations":[{"path":gone}]}),
                    true,
                ),
                ("external", json!({"books":[outside]}), false),
                ("home", json!({"books":["~/Books/x.db"]}), false),
                (
                    "mixed",
                    json!({"recent":[{"path":gone},{"path":outside}]}),
                    false,
                ),
            ]
            {
                let root = tempdir().unwrap();
                let old = profile(root.path());
                let new = root.path().join(crate::APP_DIR);
                fs::create_dir(&new).unwrap();
                let body = serde_json::to_vec(&settings).unwrap();
                fs::write(new.join("settings.json"), &body).unwrap();
                let result = migrate(root.path(), copy);
                assert_eq!(
                    result.is_ok(),
                    allowed,
                    "{row}: {settings}, copy={copy}: {result:?}"
                );
                if allowed {
                    let saved = leftovers(root.path());
                    assert_eq!(saved.len(), 1);
                    assert_eq!(fs::read(saved[0].join("settings.json")).unwrap(), body);
                    assert_eq!(
                        fs::read(new.join("projects/book.db")).unwrap(),
                        b"manuscript"
                    );
                } else {
                    assert_eq!(fs::read(new.join("settings.json")).unwrap(), body);
                    assert_eq!(
                        fs::read(old.join("projects/book.db")).unwrap(),
                        b"manuscript"
                    );
                    assert!(leftovers(root.path()).is_empty());
                    assert!(!root.path().join(INTENT).exists());
                    assert!(!root.path().join(STAGE).exists());
                }
            }
        }
    }

    #[test]
    fn temporary_directory_cannot_cover_the_home_or_data_home() {
        if std::env::var_os("GARRET_MIGRATION_CHILD").is_none() {
            for which in ["home", "data", "ancestor"] {
                let root = tempdir().unwrap();
                let home = root.path().join("home");
                let data = root.path().join("data");
                let temp = match which {
                    "home" => home.clone(),
                    "data" => data.clone(),
                    _ => root.path().to_path_buf(),
                };
                isolated_case(
                    "temporary_directory_cannot_cover_the_home_or_data_home",
                    &home,
                    &data,
                    &temp,
                );
            }
            return;
        }
        let data = PathBuf::from(std::env::var_os("XDG_DATA_HOME").unwrap());
        for copy in modes() {
            let root = data.join(if copy { "copy" } else { "move" });
            fs::create_dir(&root).unwrap();
            profile(&root);
            let new = root.join(crate::APP_DIR);
            fs::create_dir(&new).unwrap();
            fs::write(new.join("settings.json"), b"{}").unwrap();
            assert!(migrate(&root, copy).is_err());
            assert!(leftovers(&root).is_empty());
            assert_eq!(fs::read(new.join("settings.json")).unwrap(), b"{}");
        }
    }

    #[test]
    fn completed_windows_copy_never_sets_aside_a_profile() {
        let root = tempdir().unwrap();
        let old = root.path().join(LEGACY_DIR);
        fs::create_dir(&old).unwrap();
        fs::write(old.join("settings.json"), b"{}").unwrap();
        migrate(root.path(), true).unwrap();
        let new = root.path().join(crate::APP_DIR);
        assert!(completed_record(&new).unwrap().is_some());
        assert!(!copy_set_aside_candidate(root.path(), &old, &new).unwrap());
        assert!(check_copy_cli(root.path()).is_ok());
        migrate(root.path(), true).unwrap();
        assert!(leftovers(root.path()).is_empty());
        assert_eq!(fs::read(new.join("settings.json")).unwrap(), b"{}");
    }

    fn claim_guard(home: &Path) -> crate::instance_file::Guard {
        match crate::instance_file::claim(home) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        }
    }

    fn migrate(home: &Path, copy: bool) -> Result<(), String> {
        if copy {
            let guard = claim_guard(home);
            prepare_copy(home, &guard)
        } else {
            #[cfg(unix)]
            return prepare(home);
            #[cfg(windows)]
            unreachable!()
        }
    }

    fn modes() -> Vec<bool> {
        #[cfg(unix)]
        return vec![false, true];
        #[cfg(windows)]
        return vec![true];
    }

    fn leftovers(home: &Path) -> Vec<PathBuf> {
        fs::read_dir(home)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("garret.set-aside-")
            })
            .collect()
    }

    #[test]
    fn harmless_destination_is_preserved_and_books_migrate_on_both_paths() {
        if isolated_temporary_directory(
            "harmless_destination_is_preserved_and_books_migrate_on_both_paths",
        ) {
            return;
        }
        for copy in modes() {
            for companions in [false, true] {
                let temp = tempdir().unwrap();
                profile(temp.path());
                let new = temp.path().join(crate::APP_DIR);
                for name in [
                    "WebKitCache/Version 17",
                    "CacheStorage",
                    "mediakeys/v1",
                    "storage",
                ] {
                    fs::create_dir_all(new.join(name)).unwrap();
                    fs::write(new.join(name).join("salt"), b"cache").unwrap();
                }
                fs::create_dir_all(new.join("WebKitCache/Version 17/Blobs")).unwrap();
                fs::write(new.join("settings.json"), br#"{"locale":"de","books":[]}"#).unwrap();
                fs::create_dir(new.join("spell")).unwrap();
                fs::write(new.join("hsts-storage.sqlite"), b"HSTS cache").unwrap();
                if companions {
                    for name in [
                        "hsts-storage.sqlite-wal",
                        "hsts-storage.sqlite-shm",
                        "instance.lock",
                        "focus.request",
                    ] {
                        fs::write(new.join(name), b"").unwrap();
                    }
                }
                assert!(check_cli(temp.path()).is_err());
                assert!(refusal(temp.path(), &check_cli(temp.path()).unwrap_err())
                    .contains("ungenutzter Ordner aus einer früheren Installation"));
                assert_eq!(check_copy_cli(temp.path()).unwrap_err(), CLI_PENDING);
                let pending = refusal(temp.path(), CLI_PENDING);
                assert!(!pending.contains("CLI"));
                assert!(leftovers(temp.path()).is_empty());
                migrate(temp.path(), copy).unwrap();
                let saved = leftovers(temp.path());
                assert_eq!(saved.len(), 1);
                assert_eq!(
                    fs::read(saved[0].join("hsts-storage.sqlite")).unwrap(),
                    b"HSTS cache"
                );
                assert!(fs::read_dir(saved[0].join("spell"))
                    .unwrap()
                    .next()
                    .is_none());
                if companions {
                    assert!(saved[0].join("hsts-storage.sqlite-wal").is_file());
                    assert!(saved[0].join("hsts-storage.sqlite-shm").is_file());
                }
                assert_eq!(
                    fs::read(saved[0].join("settings.json")).unwrap(),
                    br#"{"locale":"de","books":[]}"#
                );
                assert_eq!(
                    fs::read(saved[0].join("WebKitCache/Version 17/salt")).unwrap(),
                    b"cache"
                );
                assert_eq!(
                    fs::read(new.join("projects/book.db")).unwrap(),
                    b"manuscript"
                );
                assert_eq!(
                    fs::read(new.join("projects/book.db-wal")).unwrap(),
                    b"uncheckpointed writing"
                );
                let receipt = temp.path().join(format!(
                    ".{}.json",
                    saved[0].file_name().unwrap().to_str().unwrap()
                ));
                let value: Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
                assert_eq!(
                    value["destination"],
                    saved[0].file_name().unwrap().to_str().unwrap()
                );
                migrate(temp.path(), copy).unwrap();
                assert_eq!(leftovers(temp.path()), saved);
            }
        }
    }

    #[test]
    fn pending_explanation_requires_a_migratable_source() {
        if isolated_temporary_directory("pending_explanation_requires_a_migratable_source") {
            return;
        }
        for copy in modes() {
            let root = tempdir().unwrap();
            let old = root.path().join(LEGACY_DIR);
            let new = root.path().join(crate::APP_DIR);
            fs::create_dir(&old).unwrap();
            fs::create_dir(&new).unwrap();
            fs::write(new.join("settings.json"), b"{}").unwrap();
            let check = |root: &Path| {
                if copy {
                    check_copy_cli(root)
                } else {
                    check_cli(root)
                }
            };
            if copy {
                assert!(check(root.path()).is_ok());
                migrate(root.path(), true).unwrap();
                assert!(leftovers(root.path()).is_empty());
            }
            fs::write(old.join("settings.json"), b"[").unwrap();
            assert_ne!(check(root.path()).unwrap_err(), CLI_PENDING);
            assert!(migrate(root.path(), copy).is_err());
            assert!(leftovers(root.path()).is_empty());
            fs::write(old.join("settings.json"), b"{}").unwrap();
            assert_eq!(check(root.path()).unwrap_err(), CLI_PENDING);
            assert!(refusal(root.path(), CLI_PENDING).contains("unused leftover folder"));
            assert!(!refusal(root.path(), CLI_PENDING).contains("CLI"));
        }
    }

    #[test]
    fn real_and_unknown_destination_entries_are_never_set_aside() {
        for copy in modes() {
            for name in [
                "projects/",
                "recovery/",
                "exports/",
                "imports/",
                "spell/en_US.dic",
                "spell/en_US.exc",
                "spell/personal.dic",
                "spell/unknown",
                "spell/nested/",
                "identities.json",
                "book.db",
                "unknown",
                "WebKit/book.db",
                "WebKit/.db",
                "WebKit/book.sqlite",
                "WebKit/book.sqlite3",
                "WebKit/book.sqlite-wal",
                "WebKit/book.sqlite-shm",
                "WebKit/book.sqlite3-wal",
                "WebKit/book.sqlite3-shm",
                "WebKit/book.localstorage",
                "WebKitCache/book.sqlite3",
                "storage/book.localstorage",
                "other.sqlite",
                "hsts-storage.sqlite3",
                "HSTS-storage.sqlite",
                "WebKit/hsts-storage.sqlite",
            ] {
                let temp = tempdir().unwrap();
                let old = profile(temp.path());
                let new = temp.path().join(crate::APP_DIR);
                fs::create_dir_all(&new).unwrap();
                if name.ends_with('/') {
                    fs::create_dir_all(new.join(name)).unwrap();
                } else {
                    fs::create_dir_all(new.join(name).parent().unwrap()).unwrap();
                    fs::write(new.join(name), b"Personalword377\n").unwrap();
                }
                assert!(migrate(temp.path(), copy).is_err(), "{name}, copy={copy}");
                assert!(new.join(name).exists());
                assert_eq!(
                    fs::read(old.join("projects/book.db")).unwrap(),
                    b"manuscript"
                );
                assert!(leftovers(temp.path()).is_empty());
            }
        }
    }

    #[test]
    fn settings_with_live_books_or_uncertain_data_refuse_on_both_paths() {
        let book = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let original = fs::read(&book).unwrap();
        assert!(!book.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        for copy in modes() {
            for value in [
                json!({"books":[book]}),
                json!({"last_project":book}),
                json!({"recent":[{"path":book}]}),
                json!({"book_locations":[{"path":book}]}),
                json!({"encrypted_backup_dir":"/archives"}),
                json!({"books":[7]}),
                json!({"books":["relative.db"]}),
                json!({"future_setting":true}),
                json!([]),
            ] {
                let temp = tempdir().unwrap();
                profile(temp.path());
                let new = temp.path().join(crate::APP_DIR);
                fs::create_dir(&new).unwrap();
                let body = serde_json::to_vec(&value).unwrap();
                fs::write(new.join("settings.json"), &body).unwrap();
                assert!(migrate(temp.path(), copy).is_err(), "{value}, copy={copy}");
                assert_eq!(fs::read(new.join("settings.json")).unwrap(), body);
                assert!(leftovers(temp.path()).is_empty());
            }
        }
        assert_eq!(fs::read(book).unwrap(), original);
    }

    #[test]
    fn set_aside_interruption_and_stale_receipt_resume_without_overwriting() {
        if isolated_temporary_directory(
            "set_aside_interruption_and_stale_receipt_resume_without_overwriting",
        ) {
            return;
        }
        for copy in modes() {
            for moved in [false, true] {
                let temp = tempdir().unwrap();
                profile(temp.path());
                let new = temp.path().join(crate::APP_DIR);
                fs::create_dir(&new).unwrap();
                fs::write(new.join("settings.json"), b"{}").unwrap();
                #[cfg(unix)]
                if !copy {
                    let intent = prepare_settings(
                        &temp.path().join(LEGACY_DIR),
                        &temp.path().join(LEGACY_DIR),
                        &new,
                        crate::projects::home_dir().as_deref(),
                    )
                    .unwrap();
                    write_new(
                        &temp.path().join(INTENT),
                        &serde_json::to_vec(&intent).unwrap(),
                    )
                    .unwrap();
                }
                let stale = temp.path().join(".garret.set-aside-interrupted.json");
                fs::write(&stale, b"receipt retained before rename").unwrap();
                if moved {
                    set_aside(temp.path()).unwrap();
                }
                migrate(temp.path(), copy).unwrap();
                assert_eq!(leftovers(temp.path()).len(), 1);
                assert_eq!(fs::read(stale).unwrap(), b"receipt retained before rename");
                assert_eq!(
                    fs::read(new.join("projects/book.db")).unwrap(),
                    b"manuscript"
                );
            }
        }
    }

    #[test]
    fn missing_newer_folder_is_omitted_in_both_languages() {
        for (locale, heading, keep, absent) in [
            (
                "en",
                "Older folder (1 book):",
                "Please keep this folder",
                "Newer folder",
            ),
            (
                "de",
                "Bisheriger Ordner (1 Buch):",
                "Bitte bewahren Sie diesen Ordner auf",
                "Neuer Ordner",
            ),
        ] {
            let temp = tempdir().unwrap();
            let old = profile(temp.path());
            let settings = serde_json::to_vec(&json!({"locale": locale})).unwrap();
            fs::write(old.join("settings.json"), &settings).unwrap();
            for detail in [
                "settings migration refused: invalid JSON",
                "application data identity is a reparse point",
            ] {
                let message = refusal(temp.path(), detail);
                assert!(message.contains(heading), "{message}");
                assert!(message.contains(keep), "{message}");
                assert!(message.contains(old.to_str().unwrap()), "{message}");
                assert!(!message.contains(absent), "{message}");
                assert!(
                    !message.contains(temp.path().join(crate::APP_DIR).to_str().unwrap()),
                    "{message}"
                );
                assert!(
                    !message.contains("both folders") && !message.contains("beide Ordner"),
                    "{message}"
                );
                assert!(message.ends_with(detail));
            }
            assert_eq!(fs::read(old.join("settings.json")).unwrap(), settings);
            assert!(!temp.path().join(crate::APP_DIR).exists());
        }
    }

    #[test]
    fn conflict_explanation_counts_books_in_both_languages_without_writing() {
        for (locale, opening, count) in [
            (
                "en",
                "Nothing was lost or changed.",
                "Older folder (1 book):",
            ),
            (
                "de",
                "Nichts ist verloren gegangen oder verändert worden.",
                "Bisheriger Ordner (1 Buch):",
            ),
        ] {
            let temp = tempdir().unwrap();
            let old = profile(temp.path());
            fs::write(old.join("settings.json"), br#"{}"#).unwrap();
            let new = temp.path().join(crate::APP_DIR);
            fs::create_dir_all(new.join("projects")).unwrap();
            fs::write(new.join("projects/other.db"), b"other book").unwrap();
            fs::write(
                new.join("settings.json"),
                serde_json::to_vec(&json!({"locale":locale})).unwrap(),
            )
            .unwrap();
            let detail = check_cli(temp.path()).unwrap_err();
            let message = refusal(temp.path(), &detail);
            assert!(message.starts_with(opening), "{message}");
            assert!(message.contains(count), "{message}");
            assert!(message.contains(if locale == "en" {
                "Newer folder (1 book):"
            } else {
                "Neuer Ordner (1 Buch):"
            }));
            assert!(message.contains("github.com/iuliandita/garret/issues"));
            assert!(
                message.contains(if locale == "en" {
                    "Please keep both folders"
                } else {
                    "Bitte bewahren Sie beide Ordner auf"
                }),
                "{message}"
            );
            assert!(message.ends_with(&detail));
            assert!(!temp.path().join(INTENT).exists());
            assert!(leftovers(temp.path()).is_empty());
            fs::remove_file(new.join("projects/other.db")).unwrap();
            fs::write(
                new.join("settings.json"),
                serde_json::to_vec(&json!({"locale":locale,"books":["/missing/book.db"]})).unwrap(),
            )
            .unwrap();
            let message = refusal(temp.path(), &detail);
            assert!(
                message.contains(if locale == "en" {
                    "Newer folder (no books found)"
                } else {
                    "Neuer Ordner (keine Bücher gefunden)"
                }),
                "{message}"
            );
            assert!(message.contains(if locale == "en" {
                "Your books appear to be in the older folder."
            } else {
                "Ihre Bücher scheinen im bisherigen Ordner zu liegen."
            }));
            fs::remove_file(old.join("projects/book.db")).unwrap();
            fs::write(new.join("projects/other.db"), b"other book").unwrap();
            let message = refusal(temp.path(), &detail);
            assert!(message.contains(if locale == "en" {
                "Your books appear to be in the newer folder."
            } else {
                "Ihre Bücher scheinen im neuen Ordner zu liegen."
            }));
            fs::write(temp.path().join(INTENT), b"{}").unwrap();
            let message = refusal(temp.path(), &detail);
            assert!(
                message.starts_with(if locale == "en" {
                    "Nothing was lost."
                } else {
                    "Nichts ist verloren gegangen."
                }),
                "{message}"
            );
            assert!(!message.starts_with(opening));
            fs::write(new.join("settings.json"), b"[").unwrap();
            let message = refusal(temp.path(), &detail);
            assert!(
                message.contains("could not be counted")
                    || message.contains("konnten nicht gezählt werden")
            );
        }
    }

    fn profile(home: &Path) -> PathBuf {
        let root = home.join(LEGACY_DIR);
        fs::create_dir_all(root.join("projects/book.pictures")).unwrap();
        fs::create_dir_all(root.join("projects/book.research")).unwrap();
        fs::create_dir_all(root.join("recovery/by-id/abc/one.point")).unwrap();
        fs::create_dir_all(root.join("mirror/book")).unwrap();
        fs::create_dir_all(root.join("encrypted-staging/.encrypted-archive-stage-retained"))
            .unwrap();
        for (name, body) in [
            ("projects/book.db", "manuscript"),
            ("projects/book.db-wal", "uncheckpointed writing"),
            ("projects/book.pictures/original.png", "picture"),
            ("projects/book.research/original.pdf", "research"),
            ("recovery/by-id/abc/one.point/inventory.json", "inventory"),
            ("mirror/book/.readable-mirror-pauses.json", "paused edits"),
            (
                "encrypted-staging/.encrypted-archive-stage-retained/plaintext",
                "retained stage",
            ),
            ("identities.json", "{\"version\":1,\"identities\":[]}"),
            ("future-file", "preserve unknown data"),
        ] {
            fs::write(root.join(name), body).unwrap();
        }
        fs::write(
            root.join("settings.json"),
            serde_json::to_vec(&json!({
                "last_project": root.join("projects/book.db"),
                "books": [root.join("projects/book.db"), "/external/book.db"],
                "book_locations": [{"book_id":"abc", "path":root.join("projects/book.db")}],
                "new_book_dir":root.join("projects"),
                "encrypted_backup_dir":root.join("archives"),
                "recent":[{"path":root.join("projects/book.db"), "name":"Book", "at_ms":4}],
                "future_preference":{"keep":true}
            }))
            .unwrap(),
        )
        .unwrap();
        root
    }

    #[test]
    fn paths_remap_by_component_and_preserve_unknown_and_external_values() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        let new = temp.path().join(crate::APP_DIR);
        let mut value: Value =
            serde_json::from_slice(&bytes(&old.join("settings.json")).unwrap()).unwrap();
        value["books"]
            .as_array_mut()
            .unwrap()
            .push(json!(format!("{}-other/book.db", old.display())));
        value["last_project"] = json!(format!(
            "~/{}",
            old.strip_prefix(temp.path())
                .unwrap()
                .join("projects/book.db")
                .display()
        ));
        fs::write(
            old.join("settings.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let intent = prepare_settings(&old, &old, &new, Some(temp.path())).unwrap();
        let moved: Value = serde_json::from_str(intent.settings_after.as_ref().unwrap()).unwrap();
        assert_eq!(moved["last_project"], json!("~/garret/projects/book.db"));
        assert_eq!(moved["books"][0], json!("~/garret/projects/book.db"));
        assert_eq!(moved["books"][1], json!("/external/book.db"));
        assert_eq!(moved["books"][2], value["books"][2]);
        assert_eq!(
            moved["book_locations"][0]["path"],
            json!("~/garret/projects/book.db")
        );
        assert_eq!(moved["new_book_dir"], json!("~/garret/projects"));
        assert_eq!(moved["encrypted_backup_dir"], json!("~/garret/archives"));
        assert_eq!(
            moved["recent"][0]["path"],
            json!("~/garret/projects/book.db")
        );
        assert_eq!(moved["future_preference"], value["future_preference"]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_move_preserves_payload_privacy_and_legacy_access_and_repeats_safely() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        let privacy = json!({"version":1,"credential":null,"policy":{
            "idle_min":15,"session_lock":true,"sleep":true,"neutral_title":true}});
        fs::write(
            old.join("privacy.json"),
            serde_json::to_vec(&privacy).unwrap(),
        )
        .unwrap();
        assert!(check_cli(temp.path()).is_err());
        assert!(!temp.path().join(crate::APP_DIR).exists());
        prepare(temp.path()).unwrap();
        let new = temp.path().join(crate::APP_DIR);
        assert!(fs::symlink_metadata(&old).unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read(old.join("projects/book.db-wal")).unwrap(),
            b"uncheckpointed writing"
        );
        assert_eq!(
            fs::read(new.join("projects/book.research/original.pdf")).unwrap(),
            b"research"
        );
        assert_eq!(
            fs::read(new.join("future-file")).unwrap(),
            b"preserve unknown data"
        );
        assert!(new
            .join("encrypted-staging/.encrypted-archive-stage-retained/plaintext")
            .exists());
        let loaded = crate::privacy::Privacy::load(temp.path());
        assert!(loaded.status().policy.neutral_title);
        assert!(check_cli(temp.path()).is_ok());
        prepare(temp.path()).unwrap();
        assert!(!temp.path().join(INTENT).exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_resumes_after_rename_and_after_settings_installation() {
        for installed in [false, true] {
            let temp = tempdir().unwrap();
            let old = profile(temp.path());
            let new = temp.path().join(crate::APP_DIR);
            let intent = prepare_settings(&old, &old, &new, None).unwrap();
            write_new(
                &temp.path().join(INTENT),
                &serde_json::to_vec(&intent).unwrap(),
            )
            .unwrap();
            move_new(&old, &new).unwrap();
            if installed {
                install_settings(&new, &intent).unwrap();
            }
            assert!(check_cli(temp.path()).is_err());
            prepare(temp.path()).unwrap();
            assert_eq!(
                fs::read(old.join("projects/book.db")).unwrap(),
                b"manuscript"
            );
            assert!(check_cli(temp.path()).is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn ambiguous_malformed_and_linked_profiles_are_preserved_without_destination() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        fs::write(old.join("settings.json"), b"damaged").unwrap();
        assert!(prepare(temp.path()).is_err());
        assert_eq!(fs::read(old.join("settings.json")).unwrap(), b"damaged");
        assert!(!temp.path().join(crate::APP_DIR).exists());
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        fs::create_dir_all(temp.path().join(crate::APP_DIR).join("projects")).unwrap();
        assert!(prepare(temp.path()).is_err());
        assert_eq!(
            fs::read(old.join("projects/book.db")).unwrap(),
            b"manuscript"
        );
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        std::os::unix::fs::symlink("projects/book.db", old.join("linked-file")).unwrap();
        assert!(prepare(temp.path()).is_err());
        assert!(!temp.path().join(crate::APP_DIR).exists());
    }

    #[test]
    fn windows_copy_retains_originals_lock_inode_and_rejects_unrelated_destination() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        let guard = claim_guard(temp.path());
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(old.join("instance.lock")).unwrap().ino()
        };
        prepare_copy(temp.path(), &guard).unwrap();
        assert!(guard.migrated().unwrap());
        assert_eq!(
            fs::read(old.join("projects/book.db")).unwrap(),
            b"manuscript"
        );
        assert_eq!(
            fs::read(temp.path().join(crate::APP_DIR).join("projects/book.db")).unwrap(),
            b"manuscript"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(old.join("instance.lock")).unwrap().ino(),
                inode
            );
        }
        prepare_copy(temp.path(), &guard).unwrap();
        drop(guard);
        assert!(!fs::read(old.join("instance.lock")).unwrap().is_empty());
        assert!(matches!(
            crate::instance_file::claim(temp.path()),
            crate::instance_file::Claim::Owned(_)
        ));
        let conflict = tempdir().unwrap();
        profile(conflict.path());
        fs::create_dir_all(conflict.path().join(crate::APP_DIR).join("projects")).unwrap();
        let guard = claim_guard(conflict.path());
        assert!(prepare_copy(conflict.path(), &guard).is_err());
        assert!(!guard.migrated().unwrap());
    }

    #[test]
    fn a_copied_completion_record_cannot_authorize_independent_directories() {
        let source = tempdir().unwrap();
        profile(source.path());
        let guard = claim_guard(source.path());
        prepare_copy(source.path(), &guard).unwrap();
        let other = tempdir().unwrap();
        profile(other.path());
        fs::create_dir(other.path().join(crate::APP_DIR)).unwrap();
        fs::copy(
            source.path().join(crate::APP_DIR).join(RECORD),
            other.path().join(crate::APP_DIR).join(RECORD),
        )
        .unwrap();
        let other_guard = claim_guard(other.path());
        other_guard.mark_migrated().unwrap();
        assert!(prepare_copy(other.path(), &other_guard).is_err());
        assert_eq!(
            fs::read(other.path().join(LEGACY_DIR).join("projects/book.db")).unwrap(),
            b"manuscript"
        );
    }

    #[test]
    fn windows_unfinished_copy_and_changed_source_refuse_without_cleanup() {
        let temp = tempdir().unwrap();
        profile(temp.path());
        fs::create_dir(temp.path().join(STAGE)).unwrap();
        fs::write(temp.path().join(STAGE).join("retained"), b"incomplete").unwrap();
        let guard = claim_guard(temp.path());
        assert!(prepare_copy(temp.path(), &guard).is_err());
        assert_eq!(
            fs::read(temp.path().join(STAGE).join("retained")).unwrap(),
            b"incomplete"
        );
        assert!(!guard.migrated().unwrap());
    }

    #[test]
    fn windows_ready_copy_resumes_but_added_or_changed_source_is_refused() {
        for change in [false, true] {
            let temp = tempdir().unwrap();
            let old = profile(temp.path());
            let new = temp.path().join(crate::APP_DIR);
            let stage = temp.path().join(STAGE);
            let guard = claim_guard(temp.path());
            fs::create_dir(&stage).unwrap();
            let mut record = CopyRecord {
                version: 1,
                destination_identity: source_identity(&stage).unwrap(),
                intent: prepare_settings(&old, &old, &new, None).unwrap(),
                files: Vec::new(),
            };
            copy_tree(&old, &stage, Path::new(""), &mut record.files).unwrap();
            install_settings(&stage, &record.intent).unwrap();
            write_new(&stage.join(RECORD), &serde_json::to_vec(&record).unwrap()).unwrap();
            if change {
                fs::write(old.join("new-writing"), b"arrived after copy").unwrap();
                assert!(prepare_copy(temp.path(), &guard).is_err());
                assert!(!new.exists());
                assert!(stage.exists());
                assert!(!guard.migrated().unwrap());
            } else {
                prepare_copy(temp.path(), &guard).unwrap();
                assert!(new.exists());
                assert!(!stage.exists());
                assert!(guard.migrated().unwrap());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn enrolled_privacy_stays_locked_and_corrupt_privacy_does_not_move() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        let enrollment = tempdir().unwrap();
        let privacy = crate::privacy::Privacy::load(enrollment.path());
        privacy
            .enroll(
                privacy.generation(),
                crate::privacy::SecretKind::Pin,
                "123456".into(),
                "123456".into(),
                crate::privacy::Policy::default(),
            )
            .unwrap();
        let original =
            fs::read(enrollment.path().join(crate::APP_DIR).join("privacy.json")).unwrap();
        fs::write(old.join("privacy.json"), &original).unwrap();
        prepare(temp.path()).unwrap();
        assert_eq!(
            fs::read(temp.path().join(crate::APP_DIR).join("privacy.json")).unwrap(),
            original
        );
        assert_eq!(
            crate::privacy::Privacy::load(temp.path()).status().state,
            crate::privacy::LockState::Locked
        );
        let corrupt = tempdir().unwrap();
        let old = profile(corrupt.path());
        fs::write(old.join("privacy.json"), b"damaged").unwrap();
        assert!(prepare(corrupt.path()).is_err());
        assert!(!corrupt.path().join(crate::APP_DIR).exists());
        assert_eq!(fs::read(old.join("privacy.json")).unwrap(), b"damaged");
    }

    #[test]
    fn refusal_uses_the_existing_profiles_language_without_creating_new_data() {
        let temp = tempdir().unwrap();
        let old = profile(temp.path());
        fs::write(old.join("settings.json"), br#"{"locale":"de"}"#).unwrap();
        let message = refusal(temp.path(), "detail");
        assert!(message.contains("Ihre Bücher wurden aufbewahrt"));
        assert!(message.contains("github.com/iuliandita/garret/issues"));
        assert!(message.contains("Technische Details (Englisch)"));
        assert!(message.contains(&old.to_string_lossy().to_string()));
        assert!(!message.contains(
            &temp
                .path()
                .join(crate::APP_DIR)
                .to_string_lossy()
                .to_string()
        ));
        assert!(message.ends_with("detail"));
        assert!(!temp.path().join(crate::APP_DIR).exists());
    }
}
