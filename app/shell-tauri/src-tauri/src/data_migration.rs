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
const CLI_PENDING: &str = "open garret to set aside an empty leftover folder before using the CLI";
#[cfg(any(windows, test))]
const STAGE: &str = ".garret-data-migration";
#[cfg(any(windows, test))]
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
    let guidance = locale.strings().f(
        "startup.data_migration",
        &[
            (
                "status",
                &locale.strings().t(
                    if real_directory(&old).unwrap_or(false)
                        && real_directory(&new).unwrap_or(false)
                    {
                        "startup.data_migration_unchanged"
                    } else {
                        "startup.data_migration_preserved"
                    },
                ),
            ),
            ("old", &old.to_string_lossy()),
            ("new", &new.to_string_lossy()),
            (
                "old_count",
                &book_count(&old).map_or_else(|| "?".into(), |n| n.to_string()),
            ),
            (
                "new_count",
                &book_count(&new).map_or_else(|| "?".into(), |n| n.to_string()),
            ),
        ],
    );
    format!("{guidance}\n{detail}")
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
            paths.insert(fs::canonicalize(&path).unwrap_or(path));
        }
    }
    let projects = root.join("projects");
    if real_directory(&projects).ok()? {
        for entry in fs::read_dir(projects).ok()? {
            let path = entry.ok()?.path();
            if path.extension().is_some_and(|ext| ext == "db") {
                paths.insert(fs::canonicalize(&path).unwrap_or(path));
            }
        }
    }
    Some(paths.len())
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
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    for raw in book_paths(&value)? {
        let path = expanded_path(raw)?;
        match fs::canonicalize(path) {
            Ok(path) if !path.starts_with(&temp) => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(true)
}

fn harmless_folder(root: &Path) -> Result<bool, String> {
    validate_tree(root, 0)?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let meta = metadata(&path)?.ok_or("leftover folder changed during inspection")?;
        let allowed = if meta.is_dir() {
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some(
                    "WebKit"
                        | "webkitgtk"
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
        if [".db", ".db-wal", ".db-shm"]
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
        eprintln!("An empty leftover folder was set aside as {name}.");
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
        return Err("application data migration is unfinished; open garret to finish it before using the CLI".into());
    }
    #[cfg(unix)]
    if legacy_alias(&old, &new)? {
        return Ok(());
    }
    let old_exists = real_directory(&old)?;
    let new_exists = real_directory(&new)?;
    if old_exists && new_exists && harmless_folder(&new).unwrap_or(false) {
        return Err(CLI_PENDING.into());
    }
    #[cfg(windows)]
    {
        if old_exists && has_payload(&old)? {
            if new_exists {
                if let Some(record) = completed_record(&new)? {
                    verify_completed(&old, &new, &record)?;
                    return Ok(());
                }
            }
            return Err("application data must be moved first; close older garret versions and open garret before using the CLI".into());
        }
        if metadata(&data_home.join(STAGE))?.is_some() {
            return Err(
                "application data migration is unfinished; open garret before using the CLI".into(),
            );
        }
    }
    #[cfg(unix)]
    if old_exists {
        return Err(if new_exists { "both application data folders need to be kept" } else {
            "application data must be moved first; close older garret versions and open garret before using the CLI" }.into());
    }
    let _ = new_exists;
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
        if new_exists && !harmless_folder(&new)? {
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
        if has_payload(&old)? && harmless_folder(&new)? {
            validate_profile(&old)?;
            prepare_settings(&old, &old, &new, crate::projects::home_dir().as_deref())?;
            set_aside(data_home)?;
        } else {
            if has_payload(&old)? {
                let record = completed_record(&new)?
                    .ok_or("both application data directories exist; neither was changed")?;
                if !guard.migrated()? {
                    return Err(
                        "both application data directories exist; neither was changed".into(),
                    );
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
    use tempfile::tempdir;

    fn migrate(home: &Path, copy: bool) -> Result<(), String> {
        if copy {
            let guard = match crate::instance_file::claim(home) {
                crate::instance_file::Claim::Owned(guard) => guard,
                _ => panic!("ownership"),
            };
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
        for copy in modes() {
            let temp = tempdir().unwrap();
            profile(temp.path());
            let new = temp.path().join(crate::APP_DIR);
            fs::create_dir_all(new.join("WebKit/Cache")).unwrap();
            fs::write(new.join("WebKit/Cache/data"), b"cache").unwrap();
            fs::write(new.join("settings.json"), br#"{"locale":"de","books":[]}"#).unwrap();
            fs::write(new.join("instance.lock"), b"").unwrap();
            fs::write(new.join("focus.request"), b"").unwrap();
            assert!(check_cli(temp.path()).is_err());
            assert!(refusal(temp.path(), &check_cli(temp.path()).unwrap_err())
                .contains("Öffnen Sie garret einmal"));
            assert!(leftovers(temp.path()).is_empty());
            migrate(temp.path(), copy).unwrap();
            let saved = leftovers(temp.path());
            assert_eq!(saved.len(), 1);
            assert_eq!(
                fs::read(saved[0].join("settings.json")).unwrap(),
                br#"{"locale":"de","books":[]}"#
            );
            assert_eq!(
                fs::read(saved[0].join("WebKit/Cache/data")).unwrap(),
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

    #[test]
    fn real_and_unknown_destination_entries_are_never_set_aside() {
        for copy in modes() {
            for name in [
                "projects/",
                "recovery/",
                "exports/",
                "imports/",
                "spell/",
                "identities.json",
                "book.db",
                "unknown",
                "WebKit/book.db",
                "WebKit/.db",
            ] {
                let temp = tempdir().unwrap();
                let old = profile(temp.path());
                let new = temp.path().join(crate::APP_DIR);
                fs::create_dir_all(&new).unwrap();
                if name.ends_with('/') {
                    fs::create_dir_all(new.join(name)).unwrap();
                } else {
                    fs::create_dir_all(new.join(name).parent().unwrap()).unwrap();
                    fs::write(new.join(name), b"keep").unwrap();
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
    fn conflict_explanation_counts_books_in_both_languages_without_writing() {
        for (locale, opening, count) in [
            (
                "en",
                "Nothing was lost or changed.",
                "Older folder (books: 1):",
            ),
            (
                "de",
                "Nichts ist verloren gegangen oder verändert worden.",
                "Bisheriger Ordner (Bücher: 1):",
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
                "Newer folder (books: 1):"
            } else {
                "Neuer Ordner (Bücher: 1):"
            }));
            assert!(message.contains("github.com/iuliandita/garret/issues"));
            assert!(message.ends_with(&detail));
            assert!(!temp.path().join(INTENT).exists());
            assert!(leftovers(temp.path()).is_empty());
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
        let guard = match crate::instance_file::claim(temp.path()) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        };
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
        let guard = match crate::instance_file::claim(conflict.path()) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        };
        assert!(prepare_copy(conflict.path(), &guard).is_err());
        assert!(!guard.migrated().unwrap());
    }

    #[test]
    fn a_copied_completion_record_cannot_authorize_independent_directories() {
        let source = tempdir().unwrap();
        profile(source.path());
        let guard = match crate::instance_file::claim(source.path()) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        };
        prepare_copy(source.path(), &guard).unwrap();
        let other = tempdir().unwrap();
        profile(other.path());
        fs::create_dir(other.path().join(crate::APP_DIR)).unwrap();
        fs::copy(
            source.path().join(crate::APP_DIR).join(RECORD),
            other.path().join(crate::APP_DIR).join(RECORD),
        )
        .unwrap();
        let other_guard = match crate::instance_file::claim(other.path()) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        };
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
        let guard = match crate::instance_file::claim(temp.path()) {
            crate::instance_file::Claim::Owned(guard) => guard,
            _ => panic!("ownership"),
        };
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
            let guard = match crate::instance_file::claim(temp.path()) {
                crate::instance_file::Claim::Owned(guard) => guard,
                _ => panic!("ownership"),
            };
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
        assert!(message.contains(
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
