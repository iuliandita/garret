//! A complete point folder carried as uncompressed tar inside binary age v1.
//! The secret identity never crosses the host/page boundary.

use crate::{backup_bundle, pictures, research};
#[cfg(not(target_os = "android"))]
use crate::{projects, store::Store};
use age::secrecy::ExposeSecret;
use age::x25519::Identity;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::str::FromStr;
use tempfile::{Builder, TempDir};
use zeroize::Zeroizing;

const KEY_LIMIT: u64 = 512;
const HEADER_LIMIT: u64 = 64 * 1024;
const DB_LIMIT: u64 = 32 * 1024 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024 * 1024;
const TRAILER_LIMIT: u64 = 1024;
const STAGE_PREFIX: &str = ".encrypted-archive-stage-";
const STAGE_MARKER: &str = "owner-v1";
const STAGE_LOCK: &str = ".encrypted-archive.lock";
const STAGE_MARKER_CONTENT: &[u8] = b"writing-studio-encrypted-stage-v1\n";
const MAX_STAGES: usize = 128;
#[cfg(not(target_os = "android"))]
const PRIVATE_STAGE_DIR: &str = "encrypted-staging";

#[derive(Debug, Clone, Serialize)]
pub struct KeyInfo {
    pub recipient: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveInfo {
    pub file: String,
    pub bytes: u64,
    pub recipient: String,
    pub encrypted: bool,
}

#[derive(Deserialize)]
struct InventoryNames {
    version: u32,
    expected: Vec<String>,
    assets: Vec<AssetName>,
    #[serde(default)]
    research_expected: Vec<String>,
    #[serde(default)]
    research_assets: Vec<AssetName>,
}

#[derive(Deserialize)]
struct AssetName {
    name: String,
    bytes: u64,
}

fn safe_file(path: &Path, max: u64) -> Result<File, String> {
    backup_bundle::open_regular_with_limit(path, max).map_err(str::to_string)
}

pub(crate) fn read_key<R: Read>(reader: R) -> Result<Identity, String> {
    let mut bytes = Zeroizing::new(Vec::new());
    reader.take(KEY_LIMIT + 1).read_to_end(&mut bytes)
        .map_err(|_| "recovery key unreadable")?;
    if bytes.len() as u64 > KEY_LIMIT {
        return Err("recovery key too large".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "recovery key malformed")?;
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if found.is_some() { return Err("recovery key must contain exactly one identity".into()); }
        found = Some(Identity::from_str(line).map_err(|_| "recovery key malformed")?);
    }
    found.ok_or_else(|| "recovery key has no X25519 identity".into())
}

pub fn key_from_path(path: &Path) -> Result<Identity, String> {
    read_key(safe_file(path, KEY_LIMIT)?)
}

pub fn key_from_stdin() -> Result<Identity, String> {
    use std::io::IsTerminal;
    if io::stdin().is_terminal() { return Err("recovery key stdin must be non-interactive".into()); }
    read_key(io::stdin().lock())
}

pub fn key_info(key: &Identity) -> KeyInfo {
    KeyInfo { recipient: key.to_public().to_string() }
}

pub fn generate_key(path: &Path) -> Result<KeyInfo, String> {
    let key = Identity::generate();
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| format!("cannot create recovery key: {e}"))?;
    let secret = key.to_string();
    let text = Zeroizing::new(format!("# public key: {}\n{}\n", key.to_public(), secret.expose_secret()));
    if let Err(e) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(format!("cannot save recovery key: {e}"));
    }
    drop(file);
    let reread = key_from_path(path)?;
    if reread.to_public() != key.to_public() {
        return Err("recovery key changed after writing".into());
    }
    if let Some(parent) = path.parent() { backup_bundle::sync_directory(parent)?; }
    Ok(key_info(&reread))
}

pub fn list_stages(parent: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(parent).map_err(|_| "archive destination directory unreadable")? {
        let entry = entry.map_err(|_| "archive destination directory unreadable")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(STAGE_PREFIX) { continue; }
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| "staging metadata unreadable")?;
        if !meta.is_dir() || meta.file_type().is_symlink() { continue; }
        let marker = entry.path().join(STAGE_MARKER);
        let Ok(mut file) = safe_file(&marker, STAGE_MARKER_CONTENT.len() as u64) else { continue; };
        let mut content = Vec::new();
        file.read_to_end(&mut content).map_err(|_| "staging marker unreadable")?;
        if content == STAGE_MARKER_CONTENT {
            names.push(name);
            if names.len() > MAX_STAGES { return Err("too many retained encrypted archive stages".into()); }
        }
    }
    names.sort();
    Ok(names)
}

pub fn cleanup_stage(parent: &Path, name: &str) -> Result<(), String> {
    if !name.strip_prefix(STAGE_PREFIX).is_some_and(|suffix|
        !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        return Err("unsafe encrypted staging name".into());
    }
    let _lock = stage_lock(parent)?;
    if !list_stages(parent)?.iter().any(|found| found == name) {
        return Err("encrypted staging marker missing or unrecognized".into());
    }
    fs::remove_dir_all(parent.join(name)).map_err(|e| format!("encrypted staging cleanup failed: {e}"))?;
    backup_bundle::sync_directory(parent)
}

pub(crate) struct Stage { temp: TempDir, _lock: File }
impl Stage {
    pub(crate) fn path(&self) -> &Path { self.temp.path() }
    pub(crate) fn close(self) -> io::Result<()> { self.temp.close() }
    #[cfg(test)]
    fn keep(self) -> PathBuf { self.temp.keep() }
}

fn stage_lock(parent: &Path) -> Result<File, String> {
    let path = parent.join(STAGE_LOCK);
    let before = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Some(meta),
        Ok(_) => return Err("encrypted archive lock is unsafe".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return Err("encrypted archive lock unavailable".into()),
    };
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Do not follow reparse points or permit deletion while holding this inode.
        options.custom_flags(0x0020_0000).share_mode(0x0000_0003);
    }
    let file = options.open(&path).map_err(|_| "encrypted archive lock unavailable")?;
    let opened = file.metadata().map_err(|_| "encrypted archive lock unavailable")?;
    let after = fs::symlink_metadata(&path).map_err(|_| "encrypted archive lock changed")?;
    if !opened.is_file() || !after.is_file() || after.file_type().is_symlink() {
        return Err("encrypted archive lock is unsafe".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let same = |meta: &fs::Metadata| meta.dev() == opened.dev() && meta.ino() == opened.ino();
        if !same(&after) || before.as_ref().is_some_and(|meta| !same(meta)) {
            return Err("encrypted archive lock changed".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x0000_0400 != 0
            || after.file_attributes() & 0x0000_0400 != 0
            || before.as_ref().is_some_and(|meta| meta.file_attributes() & 0x0000_0400 != 0)
        {
            return Err("encrypted archive lock is unsafe".into());
        }
    }
    file.try_lock().map_err(|_| "another encrypted archive job is active")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = fs::symlink_metadata(&path).map_err(|_| "encrypted archive lock changed")?;
        if current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err("encrypted archive lock changed".into());
        }
    }
    Ok(file)
}

fn checked_stage_directory(path: &Path, private: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "private staging directory unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("private staging directory is unsafe".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err("private staging directory has another owner".into());
        }
        let forbidden = if private { 0o077 } else { 0o022 };
        if meta.mode() & forbidden != 0 {
            return Err("private staging directory permissions are too broad".into());
        }
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x0000_0400 != 0 {
            return Err("private staging directory is a reparse point".into());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn private_stage_root(data_home: &Path) -> Result<PathBuf, String> {
    let app_dir = data_home.join(crate::APP_DIR);
    fs::create_dir_all(&app_dir).map_err(|_| "application staging parent unavailable")?;
    checked_stage_directory(&app_dir, false)?;
    let root = app_dir.join(PRIVATE_STAGE_DIR);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&root) {
        Ok(()) => backup_bundle::sync_directory(&app_dir)?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("private staging directory unavailable".into()),
    }
    checked_stage_directory(&root, true)?;
    Ok(root)
}

#[derive(Clone, Copy)]
enum StageScope { Private, Destination }

fn stage(parent: &Path, scope: StageScope) -> Result<Stage, String> {
    let lock = stage_lock(parent)?;
    if let Some(name) = list_stages(parent)?.first() {
        let scope = match scope {
            StageScope::Private => "application-private temporary backup files (may contain plaintext)",
            StageScope::Destination => "destination temporary encrypted files",
        };
        return Err(format!("unfinished encrypted archive staging {name}; {scope}; parent directory: {}; retained stage: {}; inspect and preserve these files before deliberately discarding them", parent.display(), parent.join(name).display()));
    }
    let temp = Builder::new().prefix(STAGE_PREFIX).tempdir_in(parent)
        .map_err(|e| format!("archive staging unavailable: {e}"))?;
    let mut marker = File::create(temp.path().join(STAGE_MARKER))
        .map_err(|e| format!("archive staging marker failed: {e}"))?;
    marker.write_all(STAGE_MARKER_CONTENT).and_then(|_| marker.sync_all())
        .map_err(|e| format!("archive staging marker failed: {e}"))?;
    backup_bundle::sync_directory(temp.path())?;
    Ok(Stage { temp, _lock: lock })
}

/// The mobile host supplies its own app-private parent, never a provider URI.
pub(crate) fn private_stage(parent: &Path) -> Result<Stage, String> {
    checked_stage_directory(parent, true)?;
    stage(parent, StageScope::Private)
}

fn append(builder: &mut tar::Builder<impl Write>, path: &Path, name: &str, max: u64) -> Result<(), String> {
    if name.as_bytes().len() > 100 || !name.is_ascii() {
        return Err("bundle has an unsupported tar entry name".into());
    }
    let mut file = safe_file(path, max)?;
    let before = file.metadata().map_err(|_| "bundle file metadata unreadable")?;
    let mut header = tar::Header::new_ustar();
    header.set_path(name).map_err(|_| "bundle tar entry name unsupported")?;
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(before.len());
    header.set_mode(0o600);
    header.set_cksum();
    builder.append(&header, &mut file).map_err(|_| "bundle could not be encrypted")?;
    let after = file.metadata().map_err(|_| "bundle file metadata unreadable")?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("bundle changed while encrypting".into());
    }
    Ok(())
}

fn write_cipher(bundle: &Path, out: &Path, key: &Identity) -> Result<(), String> {
    let assets = backup_bundle::verified_payload(bundle)
        .map_err(|e| format!("only complete bundles can be encrypted: {e}"))?;
    let research_assets = backup_bundle::verified_research_payload(bundle)?;
    let mut total = 0u64;
    for (path, max) in [
        (bundle.join(backup_bundle::INVENTORY_NAME), backup_bundle::MAX_INVENTORY_BYTES),
        (backup_bundle::db_path(bundle), DB_LIMIT),
    ].into_iter().chain(assets.iter().map(|(name, _)|
        (bundle.join(backup_bundle::PICTURES_NAME).join(name), pictures::MAX_PICTURE_BYTES)))
        .chain(research_assets.iter().map(|(name, _)|
            (bundle.join(backup_bundle::RESEARCH_NAME).join(name), crate::store::knowledge::MAX_RESOURCE_BYTES))) {
        total = total.checked_add(safe_file(&path, max)?.metadata().map_err(|_| "bundle file metadata unreadable")?.len())
            .ok_or("bundle payload size overflow")?;
        if total > TOTAL_LIMIT { return Err("bundle too large for encrypted archive".into()); }
    }
    let file = OpenOptions::new().write(true).create_new(true).open(out)
        .map_err(|e| format!("cannot create ciphertext staging: {e}"))?;
    let recipient = key.to_public();
    let encryptor = age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
        .map_err(|_| "cannot start age encryption")?;
    let writer = encryptor.wrap_output(file).map_err(|_| "cannot write age header")?;
    let mut tar = tar::Builder::new(writer);
    append(&mut tar, &bundle.join(backup_bundle::INVENTORY_NAME), backup_bundle::INVENTORY_NAME, backup_bundle::MAX_INVENTORY_BYTES)?;
    append(&mut tar, &backup_bundle::db_path(bundle), backup_bundle::DB_NAME, DB_LIMIT)?;
    let mut picture_dir = tar::Header::new_ustar();
    picture_dir.set_path(format!("{}/", backup_bundle::PICTURES_NAME))
        .map_err(|_| "picture directory tar name unsupported")?;
    picture_dir.set_entry_type(tar::EntryType::Directory);
    picture_dir.set_size(0);
    picture_dir.set_mode(0o700);
    picture_dir.set_cksum();
    tar.append(&picture_dir, io::empty()).map_err(|_| "picture directory could not be encrypted")?;
    for (name, _) in &assets {
        append(&mut tar, &bundle.join(backup_bundle::PICTURES_NAME).join(name),
            &format!("{}/{name}", backup_bundle::PICTURES_NAME), pictures::MAX_PICTURE_BYTES)?;
    }
    if backup_bundle::inventory_version(bundle)? == 2 {
        let mut research_dir = tar::Header::new_ustar();
        research_dir.set_path(format!("{}/", backup_bundle::RESEARCH_NAME))
            .map_err(|_| "research directory tar name unsupported")?;
        research_dir.set_entry_type(tar::EntryType::Directory);
        research_dir.set_size(0);
        research_dir.set_mode(0o700);
        research_dir.set_cksum();
        tar.append(&research_dir, io::empty()).map_err(|_| "research directory could not be encrypted")?;
        for (name, _) in &research_assets {
            append(&mut tar, &bundle.join(backup_bundle::RESEARCH_NAME).join(name),
                &format!("{}/{name}", backup_bundle::RESEARCH_NAME), crate::store::knowledge::MAX_RESOURCE_BYTES)?;
        }
    }
    let writer = tar.into_inner().map_err(|_| "cannot finish tar archive")?;
    let file = writer.finish().map_err(|_| "cannot finish age encryption")?;
    file.sync_all().map_err(|_| "cannot sync encrypted archive")?;
    backup_bundle::verify(bundle).map_err(|e| format!("bundle changed during encryption: {e}"))
}

struct CountRead<R> { inner: R, count: Rc<Cell<u64>>, reading_header: Rc<Cell<bool>>, max_bytes: u64 }
impl<R: Read> Read for CountRead<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() { return Ok(0); }
        let available = if self.reading_header.get() {
            HEADER_LIMIT.saturating_sub(self.count.get()) as usize
        } else { buf.len() };
        if available == 0 { return Err(io::Error::new(io::ErrorKind::InvalidData, "age header too large")); }
        let limit = buf.len().min(available);
        let n = self.inner.read(&mut buf[..limit])?;
        let count = self.count.get().checked_add(n as u64)
            .filter(|count| *count <= self.max_bytes)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "encrypted archive too large"))?;
        self.count.set(count);
        Ok(n)
    }
}

pub(crate) fn extract_verified_bundle(cipher: &Path, key: &Identity, stage: &Path) -> Result<PathBuf, String> {
    extract_with_limits(cipher, key, stage, u64::MAX, TOTAL_LIMIT)
}

/// A mobile adapter admits storage before extraction and supplies its smaller
/// ciphertext and plaintext budgets. Desktop limits remain the upper ceiling.
pub(crate) fn extract_with_limits(cipher: &Path, key: &Identity, stage: &Path, max_cipher: u64, max_payload: u64) -> Result<PathBuf, String> {
    let input = safe_file(cipher, max_cipher)?;
    let cipher_size = input.metadata().map_err(|_| "encrypted archive metadata unreadable")?.len();
    let counted = Rc::new(Cell::new(0));
    let reading_header = Rc::new(Cell::new(true));
    let input = CountRead { inner: input, count: counted.clone(), reading_header: reading_header.clone(), max_bytes: max_cipher };
    let decryptor = age::Decryptor::new(input).map_err(|_| "encrypted archive header invalid")?;
    reading_header.set(false);
    if decryptor.is_scrypt() { return Err("this archive needs a passphrase, not a recovery key".into()); }
    let reader = decryptor.decrypt(std::iter::once(key as &dyn age::Identity))
        .map_err(|_| "recovery key does not open this archive")?;
    let bundle = stage.join("point");
    fs::create_dir(&bundle).map_err(|_| "decryption staging unavailable")?;
    let pictures = bundle.join(backup_bundle::PICTURES_NAME);
    fs::create_dir(&pictures).map_err(|_| "decryption pictures staging unavailable")?;
    let mut archive = tar::Archive::new(reader);
    let mut names: Option<Vec<(String, u64)>> = None;
    let mut research_names: Vec<(String, u64)> = Vec::new();
    let mut inventory_version = 0u32;
    let mut index = 0usize;
    let mut total = 0u64;
    for entry in archive.entries().map_err(|_| "encrypted tar malformed")?.raw(true) {
        let mut entry = entry.map_err(|_| "encrypted tar entry malformed")?;
        let raw = entry.header().path_bytes();
        let research_dir_index = 3 + names.as_ref().map_or(0, Vec::len);
        if index == 2 || (inventory_version == 2 && index == research_dir_index) {
            let directory = if index == 2 { backup_bundle::PICTURES_NAME } else { backup_bundle::RESEARCH_NAME };
            let expected = format!("{directory}/");
            if raw.as_ref() != expected.as_bytes() || !entry.header().entry_type().is_dir()
                || entry.header().size().map_err(|_| "encrypted tar size malformed")? != 0 {
                return Err("encrypted tar has an unexpected directory entry".into());
            }
            if index == research_dir_index && inventory_version == 2 {
                research::private_dir(&bundle.join(backup_bundle::RESEARCH_NAME))
                    .map_err(|_| "decryption research staging unavailable")?;
            }
            index += 1;
            continue;
        }
        if !entry.header().entry_type().is_file() { return Err("encrypted tar contains a non-file entry".into()); }
        let expected = match index {
            0 => backup_bundle::INVENTORY_NAME.to_string(),
            1 => backup_bundle::DB_NAME.to_string(),
            n if n < research_dir_index => {
                let assets = names.as_ref().ok_or("encrypted inventory missing")?;
                let (name, _) = assets.get(n - 3).ok_or("encrypted tar has extra entries")?;
                format!("{}/{name}", backup_bundle::PICTURES_NAME)
            }
            n => {
                if inventory_version != 2 { return Err("encrypted tar has extra entries".into()); }
                let (name, _) = research_names.get(n - research_dir_index - 1)
                    .ok_or("encrypted tar has extra entries")?;
                format!("{}/{name}", backup_bundle::RESEARCH_NAME)
            }
        };
        if raw.as_ref() != expected.as_bytes() { return Err("encrypted tar has an unexpected or unsafe name".into()); }
        let max = if index == 0 { backup_bundle::MAX_INVENTORY_BYTES } else if index == 1 { DB_LIMIT }
            else if inventory_version == 2 && index > research_dir_index { crate::store::knowledge::MAX_RESOURCE_BYTES }
            else { pictures::MAX_PICTURE_BYTES };
        let size = entry.header().size().map_err(|_| "encrypted tar size malformed")?;
        if size > max { return Err("encrypted tar entry too large".into()); }
        if index >= 3 {
            let expected_size = if inventory_version == 2 && index > research_dir_index {
                research_names[index - research_dir_index - 1].1
            } else { names.as_ref().ok_or("encrypted inventory missing")?[index - 3].1 };
            if size != expected_size { return Err("encrypted tar asset size differs from inventory".into()); }
        }
        total = total.checked_add(size).ok_or("encrypted tar payload size overflow")?;
        if total > TOTAL_LIMIT.min(max_payload) { return Err("encrypted tar payload too large".into()); }
        let out = bundle.join(&expected);
        let mut file = OpenOptions::new().write(true).create_new(true).open(&out)
            .map_err(|_| "decryption staging file unavailable")?;
        let copied = io::copy(&mut entry, &mut file).map_err(|_| "encrypted tar payload unreadable")?;
        if copied != size { return Err("encrypted tar payload truncated".into()); }
        file.sync_all().map_err(|_| "decrypted file sync failed")?;
        if index == 0 {
            let mut data = Vec::new();
            safe_file(&out, backup_bundle::MAX_INVENTORY_BYTES)?.read_to_end(&mut data)
                .map_err(|_| "decrypted inventory unreadable")?;
            let inventory: InventoryNames = serde_json::from_slice(&data)
                .map_err(|_| "decrypted inventory malformed")?;
            if !matches!(inventory.version, 1 | 2) || inventory.assets.len() != inventory.expected.len()
                || inventory.assets.len() > 100_000 || inventory.research_assets.len() != inventory.research_expected.len()
                || inventory.research_assets.len() > crate::store::knowledge::MAX_RESOURCES as usize
                || (inventory.version == 1 && !inventory.research_expected.is_empty()) {
                return Err("decrypted inventory incomplete or unsupported".into());
            }
            inventory_version = inventory.version;
            let mut seen = BTreeSet::new();
            let mut list = Vec::new();
            for (name, asset) in inventory.expected.iter().zip(inventory.assets) {
                if name != &asset.name || !pictures::is_stored_name(name) || !name.is_ascii() || name.len() > 83 || !seen.insert(name.clone()) || asset.bytes > pictures::MAX_PICTURE_BYTES {
                    return Err("decrypted inventory has an unsafe or unsupported picture name".into());
                }
                list.push((name.clone(), asset.bytes));
            }
            names = Some(list);
            let mut seen_research = BTreeSet::new();
            for (name, asset) in inventory.research_expected.iter().zip(inventory.research_assets) {
                if name != &asset.name || name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    || !seen_research.insert(name.clone()) || asset.bytes > crate::store::knowledge::MAX_RESOURCE_BYTES {
                    return Err("decrypted inventory has an unsafe research name".into());
                }
                research_names.push((name.clone(), asset.bytes));
            }
        }
        index += 1;
    }
    if index != 3 + names.as_ref().ok_or("encrypted inventory missing")?.len()
        + if inventory_version == 2 { 1 + research_names.len() } else { 0 } {
        return Err("encrypted tar lacks required files".into());
    }
    let reader = archive.into_inner();
    let mut trailer = Vec::new();
    reader.take(TRAILER_LIMIT + 1).read_to_end(&mut trailer)
        .map_err(|_| "encrypted archive authentication failed")?;
    if trailer.len() as u64 > TRAILER_LIMIT || trailer.iter().any(|b| *b != 0) {
        return Err("encrypted tar has trailing data".into());
    }
    if counted.get() != cipher_size { return Err("encrypted archive has trailing ciphertext".into()); }
    backup_bundle::sync_directory(&pictures)?;
    if inventory_version == 2 { backup_bundle::sync_directory(&bundle.join(backup_bundle::RESEARCH_NAME))?; }
    backup_bundle::sync_directory(&bundle)?;
    backup_bundle::verify(&bundle).map_err(|e| format!("decrypted bundle verification failed: {e}"))?;
    Ok(bundle)
}

/// Create an independently decrypted and verified archive at a private path.
/// The caller owns publication and keeps the stage until the provider is done.
pub(crate) fn write_verified_cipher(bundle: &Path, cipher: &Path, key: &Identity) -> Result<(), String> {
    let parent = cipher.parent().ok_or("encrypted archive has no staging parent")?;
    write_cipher(bundle, cipher, key)?;
    let check = Builder::new().prefix("encrypted-check-").tempdir_in(parent)
        .map_err(|_| "encrypted verification staging unavailable")?;
    extract_verified_bundle(cipher, key, check.path())?;
    check.close().map_err(|_| "verified plaintext cleanup failed")?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn publish_cipher_noclobber(
    source: &Path,
    destination: &Path,
    hard_link: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use rustix::fs::{renameat_with, RenameFlags, CWD};
        use rustix::io::Errno;
        match renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE) {
            Ok(()) => return Ok(()),
            Err(Errno::NOSYS | Errno::INVAL | Errno::OPNOTSUPP) => (),
            Err(error) => return Err(error.into()),
        }
    }
    #[cfg(windows)]
    {
        let _ = hard_link;
        return tempfile::TempPath::try_from_path(source)?.persist_noclobber(destination)
            .map_err(|error| error.error);
    }
    #[cfg(not(windows))]
    hard_link(source, destination)
}

#[cfg(not(target_os = "android"))]
fn publish_bundle(bundle: &Path, dest: &Path, key: &Identity, temp: &Stage, owned_snapshot: bool) -> Result<ArchiveInfo, String> {
    if fs::symlink_metadata(dest).is_ok() { return Err("encrypted archive destination already exists".into()); }
    let parent = dest.parent().ok_or("encrypted archive destination has no parent")?;
    let cipher = temp.path().join("cipher.age");
    write_verified_cipher(bundle, &cipher, key)?;
    if owned_snapshot {
        fs::remove_dir_all(bundle).map_err(|_| "private snapshot cleanup failed before publication")?;
        backup_bundle::sync_directory(temp.path())?;
    }
    let bytes = fs::metadata(&cipher).map_err(|_| "encrypted archive size unreadable")?.len();
    // Only independently verified ciphertext enters the destination filesystem.
    let destination_stage = stage(parent, StageScope::Destination)?;
    let result = (|| {
        let staged_cipher = destination_stage.path().join("cipher.age");
        let mut input = safe_file(&cipher, u64::MAX)?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(&staged_cipher)
            .map_err(|e| format!("ciphertext destination staging unavailable: {e}"))?;
        if io::copy(&mut input, &mut output).map_err(|_| "ciphertext copy failed")? != bytes {
            return Err("ciphertext copy incomplete".into());
        }
        output.sync_all().map_err(|_| "ciphertext copy sync failed")?;
        drop(output);
        let check = Builder::new().prefix("encrypted-copy-check-").tempdir_in(temp.path())
            .map_err(|_| "private ciphertext copy verification staging unavailable")?;
        extract_verified_bundle(&staged_cipher, key, check.path())?;
        check.close().map_err(|_| "verified plaintext cleanup failed")?;
        publish_cipher_noclobber(&staged_cipher, dest, |source, destination| fs::hard_link(source, destination))
            .map_err(|e| format!("encrypted archive publish failed: {e}"))?;
        if let Err(error) = backup_bundle::sync_directory(parent) {
            if fs::remove_file(dest).is_err() {
                return Err(format!("encrypted archive publication not durable: {error}; new destination could not be removed"));
            }
            return Err(format!("encrypted archive publication not durable: {error}"));
        }
        let info = ArchiveInfo {
            file: dest.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            bytes,
            recipient: key.to_public().to_string(), encrypted: true,
        };
        Ok(info)
    })();
    finish_stage(destination_stage, result)
}

#[cfg(not(target_os = "android"))]
fn finish_stage<T>(temp: Stage, result: Result<T, String>) -> Result<T, String> {
    let cleanup = temp.close();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(_)) => Err("operation finished but archive staging cleanup failed; inspect the retained staging directory".into()),
        (Err(error), Err(_)) => Err(format!("{error}; archive staging cleanup also failed")),
    }
}

#[cfg(not(target_os = "android"))]
pub fn create_from_bundle(bundle: &Path, dest: &Path, key: &Identity, data_home: &Path) -> Result<ArchiveInfo, String> {
    dest.parent().ok_or("encrypted archive destination has no parent")?;
    let temp = stage(&private_stage_root(data_home)?, StageScope::Private)?;
    let result = publish_bundle(bundle, dest, key, &temp, false);
    finish_stage(temp, result)
}

#[cfg(not(target_os = "android"))]
pub fn create_from_project(source: &Path, dest: &Path, key: &Identity, data_home: &Path) -> Result<ArchiveInfo, String> {
    dest.parent().ok_or("encrypted archive destination has no parent")?;
    let temp = stage(&private_stage_root(data_home)?, StageScope::Private)?;
    let result = (|| {
        let reader = Store::open_readonly(source).map_err(|e| format!("project unreadable: {e}"))?;
        let bundle = temp.path().join("snapshot.point");
        let written = backup_bundle::write(source, &reader, &bundle)?;
        if !written.verified { return Err(format!("complete snapshot required: {}", written.errors.join(", "))); }
        publish_bundle(&bundle, dest, key, &temp, true)
    })();
    finish_stage(temp, result)
}

#[cfg(not(target_os = "android"))]
pub fn verify(cipher: &Path, key: &Identity, data_home: &Path) -> Result<(), String> {
    let temp = stage(&private_stage_root(data_home)?, StageScope::Private)?;
    let result = extract_verified_bundle(cipher, key, temp.path()).map(|_| ());
    finish_stage(temp, result)
}

#[cfg(not(target_os = "android"))]
pub fn restore(cipher: &Path, key: &Identity, library: &Path, stem: &str, now_ms: i64, data_home: &Path)
    -> Result<projects::ProjectSummary, String>
{
    let temp = stage(&private_stage_root(data_home)?, StageScope::Private)?;
    let result = extract_verified_bundle(cipher, key, temp.path())
        .and_then(|bundle| projects::restore_point_into(&bundle, library, stem, now_ms));
    let cleaned = temp.close();
    match (result, cleaned) {
        (Ok(summary), Ok(())) => Ok(summary),
        (Err(error), Ok(())) => Err(error),
        (Ok(summary), Err(_)) => {
            let path = Path::new(&summary.path);
            let db_removed = fs::remove_file(path).is_ok();
            let pictures_removed = fs::remove_dir_all(pictures::dir_for(path)).is_ok();
            let research_removed = !research::dir_for(path).exists() || fs::remove_dir_all(research::dir_for(path)).is_ok();
            Err(format!("private restore staging cleanup failed; restored copy rollback {}", if db_removed && pictures_removed && research_removed { "completed" } else { "also failed" }))
        }
        (Err(error), Err(_)) => Err(format!("{error}; private restore staging cleanup also failed")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covers;
    #[cfg(target_os = "android")]
    use crate::store::Store;

    fn project(root: &Path) -> PathBuf {
        let db = root.join("book.db");
        let store = Store::open(&db).unwrap();
        let cast = store.cast_create("character", "Ada").unwrap();
        store.cast_set_picture(&cast.id, Some("face.png")).unwrap();
        covers::set_cover(&store, covers::SIDE_FRONT, "face.png").unwrap();
        let pictures = pictures::dir_for(&db);
        fs::create_dir(&pictures).unwrap();
        fs::write(pictures.join("face.png"), include_bytes!("../fixtures/two-halves.png")).unwrap();
        db
    }

    #[test]
    fn key_creation_is_exclusive_bounded_and_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("recovery-key.txt");
        let info = generate_key(&path).unwrap();
        assert_eq!(key_info(&key_from_path(&path).unwrap()).recipient, info.recipient);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let before = fs::read(&path).unwrap();
        assert!(generate_key(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(read_key(vec![b'x'; KEY_LIMIT as usize + 1].as_slice()).is_err());
        let doubled = [before.as_slice(), before.as_slice()].concat();
        assert!(read_key(doubled.as_slice()).is_err());
    }

    #[test]
    fn untrusted_age_header_read_stops_at_bound() {
        let counted = Rc::new(Cell::new(0));
        let mut input = CountRead {
            inner: io::repeat(b'x'), count: counted.clone(), reading_header: Rc::new(Cell::new(true)),
            max_bytes: u64::MAX,
        };
        let mut bytes = Vec::new();
        assert_eq!(input.read_to_end(&mut bytes).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(bytes.len() as u64, HEADER_LIMIT);
        assert_eq!(counted.get(), HEADER_LIMIT);
    }

    #[cfg(unix)]
    #[test]
    fn staging_lock_refuses_special_files_and_keeps_its_inode() {
        use std::os::unix::fs::{symlink, MetadataExt};
        use rustix::fs::{mkfifoat, Mode, CWD};
        let root = tempfile::tempdir().unwrap();
        let lock_path = root.path().join(STAGE_LOCK);
        mkfifoat(CWD, &lock_path, Mode::RUSR | Mode::WUSR).unwrap();
        assert!(stage_lock(root.path()).unwrap_err().contains("unsafe"));
        fs::remove_file(&lock_path).unwrap();
        let socket = std::os::unix::net::UnixListener::bind(&lock_path).unwrap();
        assert!(stage_lock(root.path()).unwrap_err().contains("unsafe"));
        drop(socket);
        fs::remove_file(&lock_path).unwrap();
        let target = root.path().join("untouched");
        fs::write(&target, b"keep").unwrap();
        symlink(&target, &lock_path).unwrap();
        assert!(stage_lock(root.path()).unwrap_err().contains("unsafe"));
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        fs::remove_file(&lock_path).unwrap();
        let held = stage_lock(root.path()).unwrap();
        let inode = held.metadata().unwrap().ino();
        assert!(stage_lock(root.path()).unwrap_err().contains("another encrypted archive job"));
        drop(held);
        let again = stage_lock(root.path()).unwrap();
        assert_eq!(again.metadata().unwrap().ino(), inode);
        drop(again);
        assert_eq!(fs::metadata(&lock_path).unwrap().ino(), inode);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn verified_cipher_publication_needs_no_hardlinks_and_preserves_collisions() {
        let root = tempfile::tempdir().unwrap();
        let db = project(root.path());
        let bundle = root.path().join("source.point");
        let reader = Store::open_readonly(&db).unwrap();
        backup_bundle::write(&db, &reader, &bundle).unwrap();
        let key = Identity::generate();
        let source = root.path().join("staged.age");
        write_verified_cipher(&bundle, &source, &key).unwrap();
        let bytes = fs::read(&source).unwrap();
        let destination = root.path().join("backup.age");
        let unsupported_links = |_: &Path, _: &Path| -> io::Result<()> {
            panic!("exclusive rename must publish even when hardlinks are unsupported")
        };
        publish_cipher_noclobber(&source, &destination, unsupported_links).unwrap();
        backup_bundle::sync_directory(root.path()).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        verify(&destination, &key, root.path()).unwrap();
        fs::write(&source, b"replacement ciphertext").unwrap();
        let error = publish_cipher_noclobber(&source, &destination, unsupported_links).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), b"replacement ciphertext");
    }

    #[test]
    fn cleanup_only_accepts_an_owned_marked_stage() {
        let root = tempfile::tempdir().unwrap();
        let temp = stage(root.path(), StageScope::Destination).unwrap();
        assert!(stage(root.path(), StageScope::Destination).err().unwrap().contains("another encrypted archive job"));
        let active_name = temp.path().file_name().unwrap().to_str().unwrap();
        assert!(cleanup_stage(root.path(), active_name).unwrap_err().contains("another encrypted archive job"));
        let name = temp.path().file_name().unwrap().to_str().unwrap().to_string();
        let retained = temp.keep();
        assert_eq!(list_stages(root.path()).unwrap(), vec![name.clone()]);
        let unrelated = root.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep"), b"keep").unwrap();
        assert!(cleanup_stage(root.path(), "../unrelated").is_err());
        assert!(cleanup_stage(root.path(), "unrelated").is_err());
        fs::write(retained.join("cipher.age"), b"partial").unwrap();
        let error = stage(root.path(), StageScope::Destination).err().unwrap();
        assert!(error.starts_with("unfinished encrypted archive staging"));
        assert!(error.contains("destination temporary encrypted files"));
        assert!(error.contains(&format!("parent directory: {}", root.path().display())));
        assert!(error.contains(&format!("retained stage: {}", retained.display())));
        assert_eq!(fs::read(retained.join("cipher.age")).unwrap(), b"partial");
        fs::write(retained.join(STAGE_MARKER), b"unrecognized").unwrap();
        assert!(cleanup_stage(root.path(), &name).unwrap_err().contains("marker missing or unrecognized"));
        assert_eq!(fs::read(retained.join("cipher.age")).unwrap(), b"partial");
        fs::write(retained.join(STAGE_MARKER), STAGE_MARKER_CONTENT).unwrap();
        cleanup_stage(root.path(), &name).unwrap();
        assert!(!retained.exists());
        stage(root.path(), StageScope::Destination).unwrap().close().unwrap();
        assert_eq!(fs::read(unrelated.join("keep")).unwrap(), b"keep");
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn verification_staging_is_private_and_separate_between_data_homes() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = private_stage_root(a.path()).unwrap();
        let second = private_stage_root(b.path()).unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with(a.path().join(crate::APP_DIR)));
        let held = stage(&first, StageScope::Private).unwrap();
        let independent = stage(&second, StageScope::Private).unwrap();
        assert_ne!(held.path(), independent.path());
        #[cfg(unix)] {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(&first).unwrap().uid(), rustix::process::geteuid().as_raw());
            drop(held);
            let mut broad = fs::metadata(&first).unwrap().permissions();
            broad.set_mode(0o755);
            fs::set_permissions(&first, broad).unwrap();
            assert!(private_stage_root(a.path()).unwrap_err().contains("permissions are too broad"));
            let linked = tempfile::tempdir().unwrap();
            let app_dir = linked.path().join(crate::APP_DIR);
            fs::create_dir(&app_dir).unwrap();
            std::os::unix::fs::symlink(&second, app_dir.join(PRIVATE_STAGE_DIR)).unwrap();
            assert!(private_stage_root(linked.path()).unwrap_err().contains("unsafe"));
        }
    }

    #[test]
    fn shared_archive_core_stages_a_complete_bundle_without_publishing_it() {
        let root = tempfile::tempdir().unwrap();
        let db = project(root.path());
        let point = root.path().join("source.point");
        let reader = Store::open_readonly(&db).unwrap();
        assert!(backup_bundle::write(&db, &reader, &point).unwrap().verified);
        let key = Identity::generate();
        let private = root.path().join("private");
        fs::create_dir(&private).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let stage = private_stage(&private).unwrap();
        let cipher = stage.path().join("transfer.age");
        write_verified_cipher(&point, &cipher, &key).unwrap();
        let cipher_bytes = fs::metadata(&cipher).unwrap().len();
        let bounded = stage.path().join("bounded");
        fs::create_dir(&bounded).unwrap();
        assert!(extract_with_limits(&cipher, &key, &bounded, cipher_bytes - 1, TOTAL_LIMIT).is_err());
        assert!(!bounded.join("point").exists());
        assert!(extract_with_limits(&cipher, &key, &bounded, cipher_bytes, 1).unwrap_err().contains("payload too large"));
        assert!(!bounded.join("point").join(backup_bundle::INVENTORY_NAME).exists());
        let unpack = stage.path().join("unpack");
        fs::create_dir(&unpack).unwrap();
        assert!(extract_verified_bundle(&cipher, &Identity::generate(), &unpack).is_err());
        let extracted = extract_with_limits(&cipher, &key, &unpack, cipher_bytes, TOTAL_LIMIT).unwrap();
        backup_bundle::verify(&extracted).unwrap();
        assert_eq!(
            fs::read(extracted.join(backup_bundle::PICTURES_NAME).join("face.png")).unwrap(),
            include_bytes!("../fixtures/two-halves.png")
        );
        stage.close().unwrap();
        assert!(!cipher.exists());
        assert!(point.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn archive_creation_requires_private_staging_and_preserves_destination_on_refusal() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let db = project(root.path());
        let point = root.path().join("source.point");
        let reader = Store::open_readonly(&db).unwrap();
        assert!(backup_bundle::write(&db, &reader, &point).unwrap().verified);
        let key = Identity::generate();
        let cipher = destination.path().join("backup.age");
        let private = private_stage_root(home.path()).unwrap();
        let held = stage(&private, StageScope::Private).unwrap();
        assert!(create_from_project(&db, &cipher, &key, home.path()).unwrap_err().contains("another encrypted archive job"));
        assert!(create_from_bundle(&point, &cipher, &key, home.path()).unwrap_err().contains("another encrypted archive job"));
        assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        let retained = held.keep();
        fs::write(retained.join("snapshot.db"), b"preserve plaintext").unwrap();
        let alternate = tempfile::tempdir().unwrap();
        let alternate_cipher = alternate.path().join("backup.age");
        let error = create_from_bundle(&point, &alternate_cipher, &key, home.path()).unwrap_err();
        assert!(error.contains("application-private temporary backup files (may contain plaintext)"));
        assert!(error.contains(&format!("parent directory: {}", private.display())));
        assert!(error.contains(&format!("retained stage: {}", retained.display())));
        assert_eq!(fs::read(retained.join("snapshot.db")).unwrap(), b"preserve plaintext");
        assert!(!alternate_cipher.exists());
        cleanup_stage(&private, retained.file_name().unwrap().to_str().unwrap()).unwrap();
        let destination_stage = stage(destination.path(), StageScope::Destination).unwrap().keep();
        fs::write(destination_stage.join("cipher.age"), b"preserve ciphertext").unwrap();
        assert!(create_from_bundle(&point, &cipher, &key, home.path()).unwrap_err().contains("destination temporary encrypted files"));
        create_from_bundle(&point, &alternate_cipher, &key, home.path()).unwrap();
        verify(&alternate_cipher, &key, home.path()).unwrap();
        assert_eq!(fs::read(destination_stage.join("cipher.age")).unwrap(), b"preserve ciphertext");
        cleanup_stage(destination.path(), destination_stage.file_name().unwrap().to_str().unwrap()).unwrap();
        create_from_bundle(&point, &cipher, &key, home.path()).unwrap();
        verify(&cipher, &key, home.path()).unwrap();
        assert!(point.exists());
        assert!(list_stages(&private).unwrap().is_empty());
        assert!(list_stages(destination.path()).unwrap().is_empty());
        let names: BTreeSet<_> = fs::read_dir(destination.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, BTreeSet::from(["backup.age".into(), STAGE_LOCK.into()]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn private_archive_staging_publishes_exclusively_across_filesystems() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir_in("/dev/shm").unwrap();
        assert_ne!(fs::metadata(root.path()).unwrap().dev(), fs::metadata(destination.path()).unwrap().dev());
        let db = project(root.path());
        let key = Identity::generate();
        let cipher = destination.path().join("backup.age");
        create_from_project(&db, &cipher, &key, root.path()).unwrap();
        let original = fs::read(&cipher).unwrap();
        verify(&cipher, &key, root.path()).unwrap();
        assert!(create_from_project(&db, &cipher, &key, root.path()).is_err());
        assert_eq!(fs::read(&cipher).unwrap(), original);
        assert!(list_stages(destination.path()).unwrap().is_empty());
        assert!(list_stages(&private_stage_root(root.path()).unwrap()).unwrap().is_empty());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn complete_real_picture_bundle_encrypts_and_restores_without_touching_source() {
        let root = tempfile::tempdir().unwrap();
        let db = project(root.path());
        let external = root.path().join("research.txt");
        fs::write(&external, b"research original").unwrap();
        let store = Store::open(&db).unwrap();
        let research = crate::research::import_copy(&db, &external, |name, bytes, hash|
            store.research_resource_add("Source", name, "text/plain", bytes, hash, "", "")
        ).unwrap();
        drop(store);
        let before = fs::read(&db).unwrap();
        let key = Identity::generate();
        let dest = root.path().join("portable.age");
        let written = create_from_project(&db, &dest, &key, root.path()).unwrap();
        assert!(written.encrypted);
        assert_eq!(written.recipient, key.to_public().to_string());
        assert!(written.bytes > 0);
        assert_eq!(fs::read(&db).unwrap(), before);
        assert!(!backup_bundle::marker_present(&db).unwrap());
        verify(&dest, &key, root.path()).unwrap();
        assert!(create_from_project(&db, &dest, &key, root.path()).is_err());
        let wrong = Identity::generate();
        let library = root.path().join("library");
        assert!(restore(&dest, &wrong, &library, "book", 1_700_000_000_000, root.path()).is_err());
        assert!(!library.exists());
        let restored = restore(&dest, &key, &library, "book", 1_700_000_000_000, root.path()).unwrap();
        let restored_db = Path::new(&restored.path);
        assert_eq!(fs::read(pictures::dir_for(restored_db).join("face.png")).unwrap(),
            include_bytes!("../fixtures/two-halves.png"));
        assert_eq!(fs::read(crate::research::path_for(restored_db, &research.sha256).unwrap()).unwrap(), b"research original");
        assert!(!backup_bundle::marker_present(restored_db).unwrap());
        assert!(Store::open_readonly(restored_db).unwrap().cast_list().unwrap()[0].picture_path.is_some());
        assert_eq!(fs::read(&db).unwrap(), before);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn externally_unpacked_image_free_tar_is_a_complete_bundle() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("empty.db");
        Store::open(&db).unwrap();
        let key = Identity::generate();
        let cipher = root.path().join("empty.age");
        create_from_project(&db, &cipher, &key, root.path()).unwrap();
        let input = File::open(&cipher).unwrap();
        let mut plaintext = Vec::new();
        age::Decryptor::new(input).unwrap()
            .decrypt(std::iter::once(&key as &dyn age::Identity)).unwrap()
            .read_to_end(&mut plaintext).unwrap();
        let unpacked = root.path().join("external.point");
        fs::create_dir(&unpacked).unwrap();
        tar::Archive::new(plaintext.as_slice()).unpack(&unpacked).unwrap();
        assert!(unpacked.join(backup_bundle::PICTURES_NAME).is_dir());
        backup_bundle::verify(&unpacked).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn missing_picture_and_changed_ciphertext_are_not_published_or_restored() {
        let root = tempfile::tempdir().unwrap();
        let db = project(root.path());
        let key = Identity::generate();
        fs::remove_file(pictures::dir_for(&db).join("face.png")).unwrap();
        let dest = root.path().join("incomplete.age");
        let error = create_from_project(&db, &dest, &key, root.path()).unwrap_err();
        assert!(error.contains("complete snapshot required") && error.contains("face.png"), "{error}");
        assert!(!dest.exists());
        fs::write(pictures::dir_for(&db).join("face.png"), include_bytes!("../fixtures/two-halves.png")).unwrap();
        create_from_project(&db, &dest, &key, root.path()).unwrap();
        let original = fs::read(&dest).unwrap();
        for changed in [original[..original.len() - 1].to_vec(), {
            let mut bytes = original.clone(); let middle = bytes.len() / 2; bytes[middle] ^= 1; bytes
        }, {
            let mut bytes = original.clone(); bytes.push(0); bytes
        }] {
            fs::write(&dest, changed).unwrap();
            let library = root.path().join("library");
            assert!(restore(&dest, &key, &library, "book", 1_700_000_000_000, root.path()).is_err());
            assert!(!library.exists());
        }
    }

    #[cfg(not(target_os = "android"))]
    fn tar_entry(name: &str, kind: tar::EntryType, data: &[u8], declared_size: u64) -> Vec<u8> {
        let mut header = tar::Header::new_ustar();
        assert!(name.len() <= 100);
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_entry_type(kind);
        header.set_size(declared_size);
        header.set_cksum();
        let mut out = header.as_bytes().to_vec();
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(512) * 512, 0);
        out
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn decrypted_tar_rejects_links_traversal_duplicate_and_oversize_before_restore() {
        let root = tempfile::tempdir().unwrap();
        let key = Identity::generate();
        let inventory = br#"{"version":1,"expected":[],"assets":[]}"#;
        let first = tar_entry("inventory.json", tar::EntryType::Regular, inventory, inventory.len() as u64);
        for second in [
            tar_entry("project.db", tar::EntryType::Symlink, &[], 0),
            tar_entry("../outside", tar::EntryType::Regular, b"x", 1),
            tar_entry("inventory.json", tar::EntryType::Regular, b"x", 1),
            tar_entry("project.db", tar::EntryType::Regular, &[], DB_LIMIT + 1),
        ] {
            let mut plain = first.clone();
            plain.extend_from_slice(&second);
            plain.extend_from_slice(&[0; 1024]);
            let mut encrypted = age::Encryptor::with_recipients(std::iter::once(&key.to_public() as &dyn age::Recipient))
                .unwrap().wrap_output(Vec::new()).unwrap();
            encrypted.write_all(&plain).unwrap();
            let cipher = root.path().join("bad.age");
            fs::write(&cipher, encrypted.finish().unwrap()).unwrap();
            let library = root.path().join("library");
            assert!(restore(&cipher, &key, &library, "book", 1_700_000_000_000, root.path()).is_err());
            assert!(!library.exists());
            assert!(!root.path().join("outside").exists());
        }
    }
}
