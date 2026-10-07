//! A portable recovery point: one directory containing a database, referenced
//! original pictures, and an inventory bound to the database bytes.

use crate::{covers, pictures, research, store::Store};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const SUFFIX: &str = ".point";
pub const DB_NAME: &str = "project.db";
pub(crate) const PICTURES_NAME: &str = "project.pictures";
pub(crate) const RESEARCH_NAME: &str = "project.research";
pub(crate) const INVENTORY_NAME: &str = "inventory.json";
pub const MARKER_KEY: &str = "backup.asset_bundle";
const VERSION: u32 = 2;
pub(crate) const MAX_INVENTORY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Marker {
    version: u32,
    expected: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    research_expected: Vec<String>,
    enumeration_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Asset {
    name: String,
    bytes: u64,
    hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Inventory {
    version: u32,
    db_hash: String,
    expected: Vec<String>,
    assets: Vec<Asset>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    research_expected: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    research_assets: Vec<Asset>,
    errors: Vec<String>,
    checksum: String,
}

#[derive(Debug, Clone)]
pub struct Written {
    pub bytes: u64,
    pub hash: String,
    pub verified: bool,
    pub database_verified: bool,
    pub errors: Vec<String>,
}

pub fn path_for(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{SUFFIX}"))
}

pub fn db_path(bundle: &Path) -> PathBuf {
    bundle.join(DB_NAME)
}

pub fn point_db(dir: &Path, id: &str, bundled: bool) -> PathBuf {
    if bundled {
        db_path(&path_for(dir, id))
    } else {
        dir.join(format!("{id}.db"))
    }
}

pub fn marker_present(db: &Path) -> Result<bool, String> {
    marker_present_typed(db).map_err(|e| e.to_string())
}

pub fn marker_present_typed(db: &Path) -> crate::store::Result<bool> {
    let store = Store::open_readonly(db)?;
    Ok(store.get_meta(MARKER_KEY)?.is_some())
}

fn references(db: &Path) -> Result<Vec<String>, String> {
    let store = Store::open_readonly(db).map_err(|_| "database unreadable".to_string())?;
    let version = store
        .user_version()
        .map_err(|_| "schema unreadable".to_string())?;
    let mut names = BTreeSet::new();
    if version >= 8 {
        for member in store
            .cast_all()
            .map_err(|_| "cast references unreadable".to_string())?
        {
            if let Some(name) = member.picture_path {
                names.insert(name);
            }
        }
    }
    for side in covers::SIDES {
        if let Some(name) =
            covers::cover_of(&store, side).map_err(|_| "cover references unreadable".to_string())?
        {
            names.insert(name);
        }
    }
    Ok(names.into_iter().collect())
}

fn research_expectations(db: &Path) -> Result<BTreeMap<String, u64>, String> {
    let store = Store::open_readonly(db).map_err(|_| "database unreadable".to_string())?;
    let mut names = BTreeMap::new();
    for resource in store.research_resources()? {
        if let Some(previous) = names.insert(resource.sha256, resource.bytes) {
            if previous != resource.bytes { return Err("research rows disagree on original size".into()); }
        }
    }
    Ok(names)
}

fn research_references(db: &Path) -> Result<Vec<String>, String> {
    Ok(research_expectations(db)?.into_keys().collect())
}

fn set_marker(db: &Path, marker: &Marker) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("snapshot marker could not open: {e}"))?;
    conn.pragma_update(None, "journal_mode", "DELETE")
        .map_err(|e| format!("snapshot marker journal failed: {e}"))?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| format!("snapshot marker sync failed: {e}"))?;
    let value = serde_json::to_string(marker).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![MARKER_KEY, value],
    )
    .map_err(|e| format!("snapshot marker write failed: {e}"))?;
    drop(conn);
    File::open(db)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("snapshot sync failed: {e}"))
}

pub fn clear_marker(db: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meta WHERE key = ?1", [MARKER_KEY])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn digest<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    Ok(format!("{:016x}", crate::store::history::hash64(&bytes)))
}

fn inventory_checksum(inventory: &Inventory) -> Result<String, String> {
    let mut blank = inventory.clone();
    blank.checksum.clear();
    digest(&blank)
}

fn name_ok(name: &str) -> bool {
    pictures::is_stored_name(name) && !name.chars().any(char::is_control)
}

pub(crate) fn open_regular_with_limit(path: &Path, limit: u64) -> Result<File, &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| "missing or unreadable")?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("not a regular file");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // NONBLOCK prevents a swapped FIFO from blocking before metadata validation.
        options.custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT, so the metadata check sees the link.
        options.custom_flags(0x0020_0000).share_mode(0x0000_0003);
    }
    let file = options.open(path).map_err(|_| "missing or unreadable")?;
    let meta = file.metadata().map_err(|_| "metadata unreadable")?;
    if !meta.is_file() {
        return Err("not a regular file");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if before.file_attributes() & 0x0000_0400 != 0 || meta.file_attributes() & 0x0000_0400 != 0 {
            return Err("not a regular file");
        }
    }
    if meta.len() > limit {
        return Err("too large");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ino() != meta.ino() || before.dev() != meta.dev() {
            return Err("source changed before open");
        }
    }
    Ok(file)
}

fn open_regular(path: &Path) -> Result<File, &'static str> {
    open_regular_with_limit(path, pictures::MAX_PICTURE_BYTES)
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("directory sync failed: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    } // Directory fsync is unavailable through std on Windows.
}

fn real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
}

fn copy_original(from: &Path, to: &Path) -> Result<Asset, &'static str> {
    let mut input = open_regular(from)?;
    let before = input.metadata().map_err(|_| "metadata unreadable")?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(|_| "destination unavailable")?;
    let mut buf = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    let mut hash = crate::store::history::FNV_OFFSET;
    loop {
        let read = input.read(&mut buf).map_err(|_| "read failed")?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > pictures::MAX_PICTURE_BYTES {
            return Err("too large");
        }
        output.write_all(&buf[..read]).map_err(|_| "write failed")?;
        hash = crate::store::history::hash64_update(hash, &buf[..read]);
    }
    output.sync_all().map_err(|_| "sync failed")?;
    let after = input.metadata().map_err(|_| "metadata unreadable")?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes != after.len()
    {
        return Err("source changed during copy");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || before.ctime() != after.ctime()
        {
            return Err("source changed during copy");
        }
    }
    Ok(Asset {
        name: to
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        bytes,
        hash: format!("{hash:016x}"),
    })
}

fn hash_regular(path: &Path) -> Result<(u64, String), &'static str> {
    let mut file = open_regular(path)?;
    let mut buf = [0u8; 64 * 1024];
    let mut hash = crate::store::history::FNV_OFFSET;
    let mut bytes = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|_| "read failed")?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > pictures::MAX_PICTURE_BYTES {
            return Err("too large");
        }
        hash = crate::store::history::hash64_update(hash, &buf[..n]);
    }
    Ok((bytes, format!("{hash:016x}")))
}

fn copy_research(from: &Path, to: &Path) -> Result<Asset, String> {
    let mut input = open_regular_with_limit(from, crate::store::knowledge::MAX_RESOURCE_BYTES)
        .map_err(str::to_string)?;
    let before = input.metadata().map_err(|_| "research metadata unreadable")?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(to).map_err(|_| "research destination unavailable")?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|_| "research read failed")?;
        if n == 0 { break; }
        bytes = bytes.checked_add(n as u64).ok_or("research size overflow")?;
        if bytes > crate::store::knowledge::MAX_RESOURCE_BYTES { return Err("research file too large".into()); }
        output.write_all(&buffer[..n]).map_err(|_| "research write failed")?;
        digest.update(&buffer[..n]);
    }
    output.sync_all().map_err(|_| "research sync failed")?;
    let after = input.metadata().map_err(|_| "research metadata unreadable")?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() || bytes != after.len() {
        return Err("research original changed during copy".into());
    }
    Ok(Asset { name: to.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        bytes, hash: format!("{:x}", digest.finalize()) })
}

fn hash_research(path: &Path) -> Result<(u64, String), String> {
    let mut file = open_regular_with_limit(path, crate::store::knowledge::MAX_RESOURCE_BYTES)
        .map_err(str::to_string)?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "research read failed")?;
        if n == 0 { break; }
        bytes = bytes.checked_add(n as u64).ok_or("research size overflow")?;
        if bytes > crate::store::knowledge::MAX_RESOURCE_BYTES { return Err("research file too large".into()); }
        digest.update(&buffer[..n]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn hash_db(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut hash = crate::store::history::FNV_OFFSET;
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash = crate::store::history::hash64_update(hash, &buf[..n]);
    }
    Ok(format!("{hash:016x}"))
}

fn payload_bytes(bundle: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for path in [db_path(bundle), bundle.join(INVENTORY_NAME)] {
        let meta =
            fs::symlink_metadata(path).map_err(|e| format!("bundle payload unreadable: {e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("bundle contains a non-file payload".into());
        }
        total = total
            .checked_add(meta.len())
            .ok_or("bundle payload size overflow")?;
    }
    let entries = fs::read_dir(bundle.join(PICTURES_NAME))
        .map_err(|e| format!("bundle pictures unreadable: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("bundle picture entry unreadable: {e}"))?;
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("bundle picture metadata unreadable: {e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("bundle contains a non-file picture entry".into());
        }
        total = total
            .checked_add(meta.len())
            .ok_or("bundle payload size overflow")?;
    }
    if real_directory(&bundle.join(RESEARCH_NAME)) {
        for entry in fs::read_dir(bundle.join(RESEARCH_NAME)).map_err(|_| "bundle research unreadable")? {
            let entry = entry.map_err(|_| "bundle research entry unreadable")?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|_| "bundle research metadata unreadable")?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("bundle contains a non-file research entry".into());
            }
            total = total.checked_add(meta.len()).ok_or("bundle payload size overflow")?;
        }
    }
    Ok(total)
}

fn read_inventory(bundle: &Path) -> Result<Inventory, String> {
    let path = bundle.join(INVENTORY_NAME);
    let file = open_regular_with_limit(&path, MAX_INVENTORY_BYTES)
        .map_err(|class| format!("inventory {class}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_INVENTORY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "inventory unreadable".to_string())?;
    if bytes.len() as u64 > MAX_INVENTORY_BYTES {
        return Err("inventory too large".into());
    }
    let inventory: Inventory =
        serde_json::from_slice(&bytes).map_err(|_| "inventory malformed".to_string())?;
    if inventory.checksum != inventory_checksum(&inventory)? {
        return Err("inventory checksum mismatch".into());
    }
    Ok(inventory)
}

fn read_marker(db: &Path) -> Result<Marker, String> {
    let store = Store::open_readonly(db).map_err(|_| "snapshot unreadable".to_string())?;
    let value = store
        .get_meta(MARKER_KEY)
        .map_err(|_| "snapshot marker unreadable".to_string())?
        .ok_or_else(|| "snapshot marker missing".to_string())?;
    let marker: Marker =
        serde_json::from_str(&value).map_err(|_| "snapshot marker malformed".to_string())?;
    if marker.version != 1 && marker.version != VERSION {
        return Err("snapshot marker version unsupported".into());
    }
    Ok(marker)
}

fn verify_database(bundle: &Path) -> Result<Inventory, String> {
    if !real_directory(bundle) {
        return Err("bundle is not a regular directory".into());
    }
    let db = db_path(bundle);
    if !fs::symlink_metadata(&db).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return Err("snapshot database missing or unsafe".into());
    }
    let validation =
        crate::validation::validate(&db).map_err(|_| "snapshot database unreadable".to_string())?;
    if !validation.ok {
        return Err("snapshot database failed validation".into());
    }
    let marker = read_marker(&db)?;
    let inventory = read_inventory(bundle)?;
    if !matches!(inventory.version, 1 | VERSION) || inventory.version != marker.version
        || inventory.expected != marker.expected || inventory.research_expected != marker.research_expected {
        return Err("asset inventory does not match snapshot marker".into());
    }
    if inventory.db_hash != hash_db(&db)? {
        return Err("snapshot database hash mismatch".into());
    }
    if marker.enumeration_ok && inventory.expected != references(&db)? {
        return Err("asset references differ from inventory".into());
    }
    if inventory.version == VERSION && marker.enumeration_ok
        && inventory.research_expected != research_references(&db)? {
        return Err("research references differ from inventory".into());
    }
    if inventory.version == 1 && (!inventory.research_expected.is_empty() || !inventory.research_assets.is_empty()) {
        return Err("version 1 inventory cannot contain research originals".into());
    }
    if inventory
        .assets
        .iter()
        .any(|a| !name_ok(&a.name) || !inventory.expected.contains(&a.name))
    {
        return Err("asset inventory has an unsafe or unreferenced name".into());
    }
    let mut recorded: Vec<&str> = inventory.assets.iter().map(|a| a.name.as_str()).collect();
    recorded.sort_unstable();
    if recorded.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("asset inventory repeats a name".into());
    }
    if inventory.research_assets.iter().any(|asset| !inventory.research_expected.contains(&asset.name)
        || asset.name != asset.hash || !asset.name.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || asset.name.len() != 64 || asset.bytes > crate::store::knowledge::MAX_RESOURCE_BYTES) {
        return Err("research inventory has an unsafe or unreferenced name".into());
    }
    let mut research_recorded: Vec<&str> = inventory.research_assets.iter().map(|a| a.name.as_str()).collect();
    research_recorded.sort_unstable();
    if research_recorded.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("research inventory repeats a name".into());
    }
    Ok(inventory)
}

pub fn verify_database_for_restore(bundle: &Path) -> Result<(), String> {
    verify_database(bundle).map(|_| ())
}

pub fn verify(bundle: &Path) -> Result<(), String> {
    let inventory = verify_database(bundle)?;
    let marker = read_marker(&db_path(bundle))?;
    if !marker.enumeration_ok {
        return Err("asset enumeration incomplete".into());
    }
    if !inventory.errors.is_empty() {
        return Err(format!(
            "asset copy incomplete: {}",
            inventory.errors.join(", ")
        ));
    }
    let recorded: Vec<String> = inventory.assets.iter().map(|a| a.name.clone()).collect();
    if recorded != inventory.expected {
        return Err("asset inventory incomplete".into());
    }
    let pictures = bundle.join(PICTURES_NAME);
    if !real_directory(&pictures) {
        return Err("pictures directory missing or unsafe".into());
    }
    let mut actual = Vec::new();
    for entry in fs::read_dir(&pictures).map_err(|_| "pictures directory unreadable")? {
        let name = entry
            .map_err(|_| "pictures directory unreadable")?
            .file_name()
            .into_string()
            .map_err(|_| "unsafe asset name")?;
        actual.push(name);
    }
    actual.sort();
    if actual != inventory.expected {
        return Err("pictures directory differs from inventory".into());
    }
    for asset in &inventory.assets {
        if !name_ok(&asset.name) {
            return Err("unsafe asset name".into());
        }
        let (bytes, hash) = hash_regular(&pictures.join(&asset.name))
            .map_err(|class| format!("{}: {class}", asset.name))?;
        if bytes != asset.bytes || hash != asset.hash {
            return Err(format!("{}: hash mismatch", asset.name));
        }
    }
    if inventory.version == VERSION {
        let sizes = research_expectations(&db_path(bundle))?;
        let recorded: Vec<String> = inventory.research_assets.iter().map(|a| a.name.clone()).collect();
        if recorded != inventory.research_expected { return Err("research inventory incomplete".into()); }
        let research_dir = bundle.join(RESEARCH_NAME);
        if !real_directory(&research_dir) { return Err("research directory missing or unsafe".into()); }
        let mut actual = Vec::new();
        for entry in fs::read_dir(&research_dir).map_err(|_| "research directory unreadable")? {
            actual.push(entry.map_err(|_| "research directory unreadable")?.file_name()
                .into_string().map_err(|_| "unsafe research name")?);
        }
        actual.sort();
        if actual != inventory.research_expected { return Err("research directory differs from inventory".into()); }
        for asset in &inventory.research_assets {
            if sizes.get(&asset.name) != Some(&asset.bytes) { return Err(format!("{}: research size differs from snapshot", asset.name)); }
            let (bytes, hash) = hash_research(&research_dir.join(&asset.name))?;
            if bytes != asset.bytes || hash != asset.hash { return Err(format!("{}: hash mismatch", asset.name)); }
        }
    }
    Ok(())
}

/// Names and sizes from a fully verified point, for an encrypted portable copy.
/// The caller must still recheck each opened source before and after streaming.
pub(crate) fn verified_payload(bundle: &Path) -> Result<Vec<(String, u64)>, String> {
    verify(bundle)?;
    let inventory = read_inventory(bundle)?;
    Ok(inventory.assets.into_iter().map(|asset| (asset.name, asset.bytes)).collect())
}

pub(crate) fn verified_research_payload(bundle: &Path) -> Result<Vec<(String, u64)>, String> {
    verify(bundle)?;
    let inventory = read_inventory(bundle)?;
    Ok(inventory.research_assets.into_iter().map(|asset| (asset.name, asset.bytes)).collect())
}

pub(crate) fn inventory_version(bundle: &Path) -> Result<u32, String> {
    verify(bundle)?;
    Ok(read_inventory(bundle)?.version)
}

pub(crate) fn restore_inventory_version(bundle: &Path) -> Result<u32, String> {
    Ok(verify_database(bundle)?.version)
}

pub fn write(source: &Path, reader: &Store, final_path: &Path) -> Result<Written, String> {
    let parent = final_path.parent().ok_or("bundle has no parent")?;
    for entry in fs::read_dir(parent).map_err(|e| format!("backup directory unreadable: {e}"))? {
        let entry = entry.map_err(|e| format!("backup directory entry unreadable: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.contains(".stage-") {
            return Err(format!(
                "unfinished backup staging directory {name}; inspect it before another backup"
            ));
        }
    }
    let stem = final_path
        .file_name()
        .ok_or("bundle has no name")?
        .to_string_lossy();
    let stage = loop {
        let mut selected = None;
        for n in 1u32..=1024 {
            let path = parent.join(format!(".{stem}.stage-{}-{n}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    selected = Some(path);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("cannot reserve staging directory: {e}")),
            }
        }
        break selected.ok_or("too many retained staging directories")?;
    };
    let db = db_path(&stage);
    if let Err(e) = reader.vacuum_into(&db) {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("snapshot copy failed: {e}"));
    }
    let (expected, picture_ok, mut errors) = match references(&db) {
        Ok(names) if names.iter().all(|name| name_ok(name)) => (names, true, Vec::new()),
        Ok(names) => (
            names.into_iter().filter(|name| name_ok(name)).collect(),
            false,
            vec!["unsafe asset name".into()],
        ),
        Err(class) => (Vec::new(), false, vec![class]),
    };
    let (research_sizes, research_ok) = match research_expectations(&db) {
        Ok(sizes) => (sizes, true),
        Err(class) => { errors.push(class); (BTreeMap::new(), false) }
    };
    let research_expected: Vec<String> = research_sizes.keys().cloned().collect();
    let enumeration_ok = picture_ok && research_ok;
    set_marker(
        &db,
        &Marker {
            version: VERSION,
            expected: expected.clone(),
            research_expected: research_expected.clone(),
            enumeration_ok,
        },
    )?;
    let db_hash = hash_db(&db)?;
    let pictures_dir = stage.join(PICTURES_NAME);
    fs::create_dir(&pictures_dir).map_err(|e| format!("picture staging failed: {e}"))?;
    let source_dir = pictures::dir_for(source);
    let mut assets = Vec::new();
    for name in &expected {
        if !real_directory(&source_dir) {
            errors.push(format!(
                "{name}: source pictures directory missing or unsafe"
            ));
            continue;
        }
        match copy_original(&source_dir.join(name), &pictures_dir.join(name)) {
            Ok(asset) => assets.push(asset),
            Err(class) => errors.push(format!("{name}: {class}")),
        }
    }
    let research_dir = stage.join(RESEARCH_NAME);
    research::private_dir(&research_dir).map_err(|e| format!("research staging failed: {e}"))?;
    let source_research = research::dir_for(source);
    let mut research_assets = Vec::new();
    for name in &research_expected {
        if !real_directory(&source_research) {
            errors.push(format!("{name}: source research directory missing or unsafe"));
            continue;
        }
        match copy_research(&source_research.join(name), &research_dir.join(name)) {
            Ok(asset) if asset.hash == *name && research_sizes.get(name) == Some(&asset.bytes) => research_assets.push(asset),
            Ok(_) => errors.push(format!("{name}: research hash or recorded size mismatch")),
            Err(class) => errors.push(format!("{name}: {class}")),
        }
    }
    let mut inventory = Inventory {
        version: VERSION,
        db_hash: db_hash.clone(),
        expected,
        assets,
        research_expected,
        research_assets,
        errors,
        checksum: String::new(),
    };
    inventory.checksum = inventory_checksum(&inventory)?;
    let text = serde_json::to_vec_pretty(&inventory).map_err(|e| e.to_string())?;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(stage.join(INVENTORY_NAME))
        .map_err(|e| format!("inventory create failed: {e}"))?;
    out.write_all(&text)
        .and_then(|_| out.sync_all())
        .map_err(|e| format!("inventory sync failed: {e}"))?;
    let bytes = payload_bytes(&stage)?;
    sync_directory(&pictures_dir)?;
    sync_directory(&research_dir)?;
    sync_directory(&stage)?;
    if fs::symlink_metadata(final_path).is_ok() {
        return Err("bundle destination already exists".into());
    }
    fs::rename(&stage, final_path).map_err(|e| format!("bundle publish failed: {e}"))?;
    sync_directory(parent)?;
    let verification = verify(final_path);
    let verified = verification.is_ok();
    let database_verified = verified || verify_database(final_path).is_ok();
    let mut errors = inventory.errors;
    if let Err(error) = verification {
        if errors.is_empty() {
            errors.push(error);
        }
    }
    Ok(Written {
        bytes,
        hash: db_hash,
        verified,
        database_verified,
        errors,
    })
}

pub fn verify_database_copy(bundle: &Path, dest_db: &Path) -> Result<(), String> {
    let inventory = read_inventory(bundle)?;
    if hash_db(dest_db)? != inventory.db_hash {
        return Err("restored database differs from the verified point".into());
    }
    Ok(())
}

pub fn copy_database(source: &Path, dest: &Path) -> Result<(), String> {
    let mut from = File::open(source).map_err(|e| format!("snapshot copy could not open: {e}"))?;
    let mut to = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(dest)
        .map_err(|e| format!("restored database unavailable: {e}"))?;
    std::io::copy(&mut from, &mut to).map_err(|e| format!("snapshot copy failed: {e}"))?;
    to.sync_all()
        .map_err(|e| format!("restored database sync failed: {e}"))
}

pub fn copy_assets(bundle: &Path, dest_db: &Path) -> Result<(), String> {
    verify(bundle)?;
    let inventory = read_inventory(bundle)?;
    let dest = pictures::dir_for(dest_db);
    if !real_directory(&dest) {
        return Err("restored pictures destination is not a directory".into());
    }
    for asset in &inventory.assets {
        let copied = copy_original(
            &bundle.join(PICTURES_NAME).join(&asset.name),
            &dest.join(&asset.name),
        )
        .map_err(|class| format!("{}: {class}", asset.name))?;
        if copied.bytes != asset.bytes || copied.hash != asset.hash {
            return Err(format!("{}: changed during restore", asset.name));
        }
    }
    if inventory.version == VERSION {
        let dest_research = research::dir_for(dest_db);
        if !real_directory(&dest_research) { return Err("restored research destination is not a directory".into()); }
        for asset in &inventory.research_assets {
            let copied = copy_research(&bundle.join(RESEARCH_NAME).join(&asset.name), &dest_research.join(&asset.name))?;
            if copied.bytes != asset.bytes || copied.hash != asset.hash {
                return Err(format!("{}: changed during restore", asset.name));
            }
        }
    }
    Ok(())
}

/// Explicit DB-first recovery: only originals whose recorded hash still
/// matches are copied. Missing references remain in the restored database.
pub fn copy_assets_with_gaps(bundle: &Path, dest_db: &Path) -> Result<Vec<String>, String> {
    let inventory = verify_database(bundle)?;
    let dest = pictures::dir_for(dest_db);
    if !real_directory(&dest) {
        return Err("restored pictures destination is not a directory".into());
    }
    let mut gaps = inventory.errors;
    if let Err(error) = verify(bundle) {
        gaps.push(error);
    }
    if !read_marker(&db_path(bundle))?.enumeration_ok {
        gaps.push("asset enumeration incomplete".into());
    }
    if !real_directory(&bundle.join(PICTURES_NAME)) {
        gaps.push("pictures directory missing or unsafe".into());
        for name in &inventory.expected {
            gaps.push(format!("{name}: original unavailable"));
        }
        gaps.sort();
        gaps.dedup();
        return Ok(gaps);
    }
    for name in &inventory.expected {
        let Some(asset) = inventory.assets.iter().find(|a| &a.name == name) else {
            gaps.push(format!("{name}: original unavailable"));
            continue;
        };
        let source = bundle.join(PICTURES_NAME).join(name);
        if !matches!(hash_regular(&source), Ok((bytes, ref hash)) if bytes == asset.bytes && hash == &asset.hash)
        {
            gaps.push(format!("{name}: original missing or changed"));
            continue;
        }
        let target = dest.join(name);
        match copy_original(&source, &target) {
            Ok(copied) if copied.bytes == asset.bytes && copied.hash == asset.hash => {}
            _ => {
                let _ = fs::remove_file(&target);
                gaps.push(format!("{name}: original changed during restore"));
            }
        }
    }
    if inventory.version == VERSION {
        let dest_research = research::dir_for(dest_db);
        if !real_directory(&dest_research) { return Err("restored research destination is not a directory".into()); }
        let sizes = research_expectations(&db_path(bundle))?;
        for name in &inventory.research_expected {
            let Some(asset) = inventory.research_assets.iter().find(|asset| &asset.name == name) else {
                gaps.push(format!("{name}: research original unavailable"));
                continue;
            };
            let source = bundle.join(RESEARCH_NAME).join(name);
            if sizes.get(name) != Some(&asset.bytes) {
                gaps.push(format!("{name}: research size differs from snapshot"));
                continue;
            }
            if !matches!(hash_research(&source), Ok((bytes, ref hash)) if bytes == asset.bytes && hash == &asset.hash) {
                gaps.push(format!("{name}: research original missing or changed"));
                continue;
            }
            let target = dest_research.join(name);
            match copy_research(&source, &target) {
                Ok(copied) if copied.bytes == asset.bytes && copied.hash == asset.hash => {}
                _ => { let _ = fs::remove_file(&target); gaps.push(format!("{name}: research original changed during restore")); }
            }
        }
    }
    gaps.sort();
    gaps.dedup();
    Ok(gaps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn regular_reader_refuses_special_files_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source");
        rustix::fs::mkfifoat(rustix::fs::CWD, &path, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR).unwrap();
        assert_eq!(open_regular_with_limit(&path, 100).unwrap_err(), "not a regular file");
        fs::remove_file(&path).unwrap();
        let socket = std::os::unix::net::UnixListener::bind(&path).unwrap();
        assert_eq!(open_regular_with_limit(&path, 100).unwrap_err(), "not a regular file");
        drop(socket);
        fs::remove_file(&path).unwrap();
        let regular = root.path().join("regular");
        fs::write(&regular, b"readable").unwrap();
        std::os::unix::fs::symlink(&regular, &path).unwrap();
        assert_eq!(open_regular_with_limit(&path, 100).unwrap_err(), "not a regular file");
        let mut file = open_regular_with_limit(&regular, 100).unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        assert_eq!(content, "readable");
    }

    fn project() -> (tempfile::TempDir, PathBuf, String) {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("book.db");
        let store = Store::open(&db).unwrap();
        let member = store.cast_create("character", "Ada").unwrap();
        store
            .cast_set_picture(&member.id, Some("face.png"))
            .unwrap();
        covers::set_cover(&store, covers::SIDE_FRONT, "face.png").unwrap();
        let dir = pictures::dir_for(&db);
        fs::create_dir(&dir).unwrap();
        let bytes = include_bytes!("../fixtures/two-halves.png");
        fs::write(dir.join("face.png"), bytes).unwrap();
        (root, db, member.id)
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn review_complete_backup_restores_all_attribution_hunks_and_discussion() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("review.db");
        let (store, item) = crate::review_validation::test_support::seed(&source);
        let authors = store.review_authors().unwrap();
        let groups = store.review_groups(&item).unwrap();
        let messages = store.review_messages(groups[0].id).unwrap();
        let bundle = root.path().join("review.point");
        let written = write(&source, &store, &bundle).unwrap();
        assert!(written.database_verified && written.verified, "{:?}", written.errors);
        let restored = crate::projects::restore_point_into(&bundle, &root.path().join("library"), "restored", 1_700_000_000_000).unwrap();
        let copy = Store::open_readonly(Path::new(&restored.path)).unwrap();
        assert_eq!(copy.review_authors().unwrap(), authors);
        assert_eq!(copy.review_groups(&item).unwrap(), groups);
        assert_eq!(copy.review_messages(groups[0].id).unwrap(), messages);
        assert_eq!(copy.load_doc(&item).unwrap().body, store.load_doc(&item).unwrap().body);
        rusqlite::Connection::open(&source).unwrap().execute("UPDATE review_hunk SET state='unknown' WHERE state='pending'", []).unwrap();
        let damaged = root.path().join("damaged.point");
        let result = write(&source, &store, &damaged).unwrap();
        assert!(!result.database_verified && !result.verified);
        assert!(verify_database_for_restore(&damaged).is_err());
    }

    #[test]
    fn a_bundle_copies_distinct_referenced_originals_and_verifies_after_moving() {
        let (root, source, _) = project();
        let source_before = fs::read(&source).unwrap();
        let output = root.path().join("point.point");
        let store = Store::open_readonly(&source).unwrap();
        let written = write(&source, &store, &output).unwrap();
        assert!(written.verified, "{:?}", written.errors);
        let db_size = fs::metadata(db_path(&output)).unwrap().len();
        let inventory_size = fs::metadata(output.join(INVENTORY_NAME)).unwrap().len();
        let image_size = fs::metadata(output.join(PICTURES_NAME).join("face.png"))
            .unwrap()
            .len();
        assert_eq!(written.bytes, db_size + inventory_size + image_size);
        assert!(written.bytes > db_size);
        assert_eq!(fs::read(&source).unwrap(), source_before);
        assert!(!marker_present(&source).unwrap());
        assert_eq!(read_inventory(&output).unwrap().assets.len(), 1);
        assert_eq!(
            fs::read(output.join(PICTURES_NAME).join("face.png")).unwrap(),
            include_bytes!("../fixtures/two-halves.png")
        );
        let moved = root.path().join("moved.point");
        fs::rename(&output, &moved).unwrap();
        verify(&moved).unwrap();
    }

    #[test]
    fn version_one_picture_inventory_remains_readable_and_future_version_refuses() {
        let (root, source, _) = project();
        let bundle = root.path().join("point.point");
        let store = Store::open_readonly(&source).unwrap();
        assert!(write(&source, &store, &bundle).unwrap().verified);
        let snapshot = db_path(&bundle);
        let mut marker = read_marker(&snapshot).unwrap();
        marker.version = 1;
        set_marker(&snapshot, &marker).unwrap();
        let mut inventory = read_inventory(&bundle).unwrap();
        inventory.version = 1;
        inventory.db_hash = hash_db(&snapshot).unwrap();
        inventory.checksum = inventory_checksum(&inventory).unwrap();
        fs::write(bundle.join(INVENTORY_NAME), serde_json::to_vec(&inventory).unwrap()).unwrap();
        verify(&bundle).unwrap();
        marker.version = VERSION + 1;
        set_marker(&snapshot, &marker).unwrap();
        assert!(verify(&bundle).unwrap_err().contains("version unsupported"));
    }

    #[test]
    fn removed_pictured_member_survives_bundle_round_trip() {
        let (root, source, id) = project();
        Store::open(&source).unwrap().cast_remove(&id).unwrap();
        let bundle = root.path().join("removed.point");
        let source_store = Store::open_readonly(&source).unwrap();
        assert!(write(&source, &source_store, &bundle).unwrap().verified);
        verify(&bundle).unwrap();
        let restored = root.path().join("restored.db");
        fs::copy(db_path(&bundle), &restored).unwrap();
        fs::create_dir(pictures::dir_for(&restored)).unwrap();
        research::private_dir(&research::dir_for(&restored)).unwrap();
        assert!(copy_assets_with_gaps(&bundle, &restored).unwrap().is_empty());
        let restored_store = Store::open(&restored).unwrap();
        assert!(restored_store.cast_list().unwrap().is_empty());
        let retained = restored_store.cast_deleted().unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, id);
        assert_eq!(retained[0].picture_path.as_deref(), Some("face.png"));
        assert_eq!(fs::read(pictures::dir_for(&restored).join("face.png")).unwrap(), include_bytes!("../fixtures/two-halves.png"));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn retained_research_originals_are_complete_in_bundle_and_restore() {
        let (root, source, _) = project();
        let external = root.path().join("notes.txt");
        fs::write(&external, b"original field notes").unwrap();
        let store = Store::open(&source).unwrap();
        let resource = research::import_copy(&source, &external, |name, bytes, hash|
            store.research_resource_add("Notes", name, "text/plain", bytes, hash, "archive", "page 2")
        ).unwrap();
        store.research_resource_remove(&resource.id).unwrap();
        drop(store);
        let bundle = root.path().join("research.point");
        let read = Store::open_readonly(&source).unwrap();
        assert!(write(&source, &read, &bundle).unwrap().verified);
        verify(&bundle).unwrap();
        assert_eq!(read_inventory(&bundle).unwrap().research_expected, vec![resource.sha256.clone()]);
        let library = root.path().join("library");
        let restored = crate::projects::restore_point_into(&bundle, &library, "restored", 1_700_000_000_000).unwrap();
        let restored_db = Path::new(&restored.path);
        assert_eq!(fs::read(research::path_for(restored_db, &resource.sha256).unwrap()).unwrap(), b"original field notes");
        assert!(Store::open_readonly(restored_db).unwrap().research_resources().unwrap()[0].removed_at.is_some());
        assert_eq!(fs::read(&external).unwrap(), b"original field notes");
        fs::write(bundle.join(RESEARCH_NAME).join(&resource.sha256), b"changed").unwrap();
        assert!(verify(&bundle).unwrap_err().contains("hash mismatch"));
        fs::remove_file(research::path_for(&source, &resource.sha256).unwrap()).unwrap();
        let incomplete = root.path().join("missing.point");
        assert!(!write(&source, &read, &incomplete).unwrap().verified);
        assert!(verify(&incomplete).is_err());
        let (recovered, gaps) = crate::projects::restore_point_with_picture_gaps(
            &incomplete, &library, "missing", 1_700_000_000_001,
        ).unwrap();
        assert!(gaps.iter().any(|gap| gap.contains("research original unavailable")));
        let recovered_db = Path::new(&recovered.path);
        assert_eq!(Store::open_readonly(recovered_db).unwrap().research_resources().unwrap().len(), 1);
        assert!(!research::path_for(recovered_db, &resource.sha256).unwrap().exists());
    }

    #[test]
    fn recorded_research_size_mismatch_keeps_snapshot_but_refuses_complete_backup() {
        let (root, source, _) = project();
        let external = root.path().join("notes.txt");
        fs::write(&external, b"field notes").unwrap();
        let store = Store::open(&source).unwrap();
        let resource = research::import_copy(&source, &external, |name, bytes, hash|
            store.research_resource_add("Notes", name, "text/plain", bytes, hash, "", "")
        ).unwrap();
        drop(store);
        rusqlite::Connection::open(&source).unwrap().execute(
            "UPDATE research_resource SET bytes=bytes+1 WHERE id=?1", [&resource.id]
        ).unwrap();
        let bundle = root.path().join("mismatch.point");
        let read = Store::open_readonly(&source).unwrap();
        let written = write(&source, &read, &bundle).unwrap();
        assert!(!written.verified);
        assert!(written.database_verified);
        assert!(written.errors.iter().any(|error| error.contains("recorded size mismatch")));
        assert!(verify(&bundle).is_err());
        let restored = root.path().join("recovered.db");
        fs::copy(db_path(&bundle), &restored).unwrap();
        fs::create_dir(pictures::dir_for(&restored)).unwrap();
        research::private_dir(&research::dir_for(&restored)).unwrap();
        let gaps = copy_assets_with_gaps(&bundle, &restored).unwrap();
        assert!(gaps.iter().any(|gap| gap.contains("research original unavailable")));
        assert!(!research::path_for(&restored, &resource.sha256).unwrap().exists());
    }

    #[test]
    fn missing_and_tampered_assets_never_verify() {
        let (root, source, _) = project();
        let store = Store::open_readonly(&source).unwrap();
        let missing = root.path().join("missing.point");
        fs::remove_file(pictures::dir_for(&source).join("face.png")).unwrap();
        let written = write(&source, &store, &missing).unwrap();
        assert!(!written.verified);
        assert!(!written.errors.is_empty());
        assert!(verify(&missing).is_err());

        fs::write(
            pictures::dir_for(&source).join("face.png"),
            include_bytes!("../fixtures/two-halves.png"),
        )
        .unwrap();
        let good = root.path().join("good.point");
        assert!(write(&source, &store, &good).unwrap().verified);
        fs::write(good.join(PICTURES_NAME).join("face.png"), b"changed").unwrap();
        assert!(verify(&good).unwrap_err().contains("hash mismatch"));
        fs::write(
            good.join(PICTURES_NAME).join("face.png"),
            include_bytes!("../fixtures/two-halves.png"),
        )
        .unwrap();
        fs::write(good.join(PICTURES_NAME).join("extra.png"), b"extra").unwrap();
        assert!(verify(&good)
            .unwrap_err()
            .contains("differs from inventory"));
        fs::remove_file(good.join(PICTURES_NAME).join("extra.png")).unwrap();
        fs::write(good.join(INVENTORY_NAME), b"{}").unwrap();
        assert!(verify(&good).unwrap_err().contains("inventory"));
        fs::remove_file(good.join(INVENTORY_NAME)).unwrap();
        assert!(verify(&good).unwrap_err().contains("inventory"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_original_is_an_incomplete_point() {
        let (root, source, _) = project();
        let target = root.path().join("outside.png");
        fs::write(&target, include_bytes!("../fixtures/two-halves.png")).unwrap();
        let original = pictures::dir_for(&source).join("face.png");
        fs::remove_file(&original).unwrap();
        std::os::unix::fs::symlink(&target, &original).unwrap();
        let store = Store::open_readonly(&source).unwrap();
        let written = write(&source, &store, &root.path().join("symlink.point")).unwrap();
        assert!(!written.verified);
        assert!(written.errors.iter().any(|e| e.contains("face.png")));
        assert_eq!(
            fs::read(&target).unwrap(),
            include_bytes!("../fixtures/two-halves.png")
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn a_detached_database_cannot_downgrade_an_asset_aware_point() {
        let (root, source, _) = project();
        let store = Store::open_readonly(&source).unwrap();
        let bundle = root.path().join("complete.point");
        assert!(write(&source, &store, &bundle).unwrap().verified);
        let detached = root.path().join("detached.db");
        fs::copy(db_path(&bundle), &detached).unwrap();
        assert!(marker_present(&detached).unwrap());
        let library = root.path().join("library");
        let error =
            crate::projects::restore_point_into(&detached, &library, "book", 1_700_000_000_000)
                .unwrap_err();
        assert!(error.contains("whole folder"), "{error}");
        assert!(!library.exists());
        let error = crate::projects::open_existing_for_writing(&db_path(&bundle))
            .unwrap_err()
            .to_string();
        assert!(error.contains("restore its whole point folder"), "{error}");
        verify(&bundle).unwrap();
    }

    #[cfg(all(unix, not(target_os = "android")))]
    #[test]
    fn partial_restore_does_not_follow_a_symlinked_picture_directory() {
        let (root, source, _) = project();
        let store = Store::open_readonly(&source).unwrap();
        let bundle = root.path().join("point.point");
        assert!(write(&source, &store, &bundle).unwrap().verified);
        fs::remove_dir_all(bundle.join(PICTURES_NAME)).unwrap();
        std::os::unix::fs::symlink(pictures::dir_for(&source), bundle.join(PICTURES_NAME)).unwrap();
        let library = root.path().join("library");
        let (restored, gaps) = crate::projects::restore_point_with_picture_gaps(
            &bundle,
            &library,
            "book",
            1_700_000_000_000,
        )
        .unwrap();
        assert!(gaps
            .iter()
            .any(|gap| gap.contains("pictures directory missing or unsafe")));
        assert!(!pictures::dir_for(Path::new(&restored.path))
            .join("face.png")
            .exists());
    }
}
