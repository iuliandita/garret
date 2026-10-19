//! Figure bytes have their own ownership. They are never deduplicated with
//! cast/cover pictures or removed automatically, even after a failed insertion.
use crate::{
    backup_bundle, pictures,
    store::{
        figure_assets::FigureAsset,
        Store,
    },
};
use sha2::{Digest, Sha256};

pub(crate) fn authoring_allowed(store: &Store) -> Result<(), String> {
    if store.user_version().map_err(|error| error.to_string())? != crate::store::READ_SCHEMA_VERSION {
        return Err("figure registration is disabled".into());
    }
    Ok(())
}
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

fn read_original(path: &Path) -> Result<Vec<u8>, String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("figure_symlink".into());
    }
    let file = backup_bundle::open_regular_with_limit(path, pictures::MAX_PICTURE_BYTES)
        .map_err(str::to_string)?;
    let mut data = Vec::new();
    file.take(pictures::MAX_PICTURE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > pictures::MAX_PICTURE_BYTES {
        return Err("figure exceeds byte limit".into());
    }
    Ok(data)
}

pub(crate) fn import_original(
    db: &Path,
    source: &Path,
    register: impl FnOnce(&FigureAsset) -> Result<(), String>,
) -> Result<FigureAsset, String> {
    let data = read_original(source)?;
    retain_bytes(db, &data, uuid::Uuid::now_v7().to_string(), register)
}

pub(crate) fn retain_bytes(
    db: &Path,
    data: &[u8],
    id: String,
    register: impl FnOnce(&FigureAsset) -> Result<(), String>,
) -> Result<FigureAsset, String> {
    admit_retained(db, data.len() as u64)?;
    let asset = prepare_asset(data, id)?;
    retain_prepared(db, data, asset, register)
}

pub(crate) fn prepare_asset(data: &[u8], id: String) -> Result<FigureAsset, String> {
    let (format, width_px, height_px) =
        pictures::inspect_original(&data).map_err(|e| e.to_string())?;
    let orientation = orientation(&data, format)?;
    Ok(FigureAsset {
        stored_name: format!("fig-{id}.{}", format.extension()),
        id,
        mime: format.mime().into(),
        bytes: data.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&data)),
        width_px,
        height_px,
        orientation,
    })
}

fn admit_retained(db: &Path, incoming: u64) -> Result<(), String> {
    if incoming > 2 * 1024 * 1024 * 1024 { return Err("figure_retention_limit".into()); }
    let dir = pictures::dir_for(db);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err("figure directory is unsafe".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    let mut count = 0usize;
    let mut bytes = incoming;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("fig-") { continue; }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        count += 1;
        bytes = bytes.checked_add(metadata.len()).ok_or("figure_retention_limit")?;
        if count >= 1024 || bytes > 2 * 1024 * 1024 * 1024 { return Err("figure_retention_limit".into()); }
    }
    Ok(())
}

pub(crate) fn retain_prepared(
    db: &Path, data: &[u8], asset: FigureAsset,
    register: impl FnOnce(&FigureAsset) -> Result<(), String>,
) -> Result<FigureAsset, String> {
    admit_retained(db, data.len() as u64)?;
    if asset.bytes != data.len() as u64 || asset.sha256 != format!("{:x}", Sha256::digest(data)) {
        return Err("prepared figure bytes changed".into());
    }
    let dir = pictures::dir_for(db);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err("figure directory is unsafe".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&dir).map_err(|e| e.to_string())?;
            backup_bundle::sync_directory(dir.parent().ok_or("figure directory has no parent")?)?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Exclusive creation and independent bytes on every platform. An uncertain
    // original is retained for salvage; a later attempt always gets a new ID.
    let mut output = options
        .open(dir.join(&asset.stored_name))
        .map_err(|e| e.to_string())?;
    output
        .write_all(&data)
        .and_then(|_| output.sync_all())
        .map_err(|e| e.to_string())?;
    backup_bundle::sync_directory(&dir)?;
    register(&asset)?;
    Ok(asset)
}

pub(crate) fn verify_original(path: &Path, asset: &FigureAsset) -> Result<(), String> {
    verified_original(path, asset).map(|_| ())
}

fn verified_original(path: &Path, asset: &FigureAsset) -> Result<Vec<u8>, String> {
    let data = read_original(path).map_err(|error| format!("figure {}: {error}", asset.id))?;
    if data.len() as u64 != asset.bytes || format!("{:x}", Sha256::digest(&data)) != asset.sha256 {
        return Err(format!(
            "figure {}: original hash or size mismatch",
            asset.id
        ));
    }
    Ok(data)
}

/// The registered figure behind one `assets/<sha256>.<png|jpg>` key of an EPUB
/// preview. The key must be `assets/` plus a known extension, and its stem must
/// EQUAL a registered lowercase SHA-256 and the extension that asset's media
/// type: equality against the registry is the whole hex check, so nothing the
/// page sends is ever joined to a path.
pub(crate) fn archive_asset(store: &Store, key: &str) -> Result<FigureAsset, String> {
    let malformed = || "figure image key is malformed".to_string();
    let (sha, ext) = key
        .strip_prefix("assets/")
        .and_then(|name| name.split_once('.'))
        .ok_or_else(malformed)?;
    let format = [pictures::Format::Png, pictures::Format::Jpeg]
        .into_iter()
        .find(|format| format.extension() == ext)
        .ok_or_else(malformed)?;
    store
        .figure_assets()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|asset| asset.sha256 == sha && asset.mime == format.mime())
        .ok_or_else(|| "unregistered figure image".to_string())
}

/// The original of an `archive_asset`, hash-verified and bounded by
/// `MAX_PICTURE_BYTES`, as a `data:` URI.
pub(crate) fn archive_image(db: &Path, asset: &FigureAsset) -> Result<String, String> {
    let data = verified_original(&pictures::dir_for(db).join(&asset.stored_name), asset)?;
    Ok(format!("data:{};base64,{}", asset.mime, pictures::base64(&data)))
}

/// Resolve a placement to a verified original; return only a bounded preview.
pub(crate) fn preview(db: &Path, store: &Store, item_id: &str, instance_id: &str, asset_id: &str) -> Result<pictures::PictureView, String> {
    let body = store.load_doc(item_id).map_err(|e| e.to_string())?.body;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|_| "unreadable figure document")?;
    let found = value["content"].as_array().is_some_and(|nodes| nodes.iter().any(|node|
        node["type"] == "figure" && node["attrs"]["id"] == instance_id && node["attrs"]["asset_id"] == asset_id));
    if !found { return Err("figure placement changed".into()); }
    let asset = store.figure_assets().map_err(|e| e.to_string())?.into_iter()
        .find(|asset| asset.id == asset_id).ok_or("unregistered figure asset")?;
    let dir = pictures::dir_for(db);
    let data = verified_original(&dir.join(&asset.stored_name), &asset)?;
    let preview = pictures::figure_preview(&data, asset.orientation).map_err(|e| e.to_string())?;
    Ok(pictures::PictureView {
        state: pictures::VIEW_PRESENT.into(),
        data_uri: Some(format!("data:image/png;base64,{}", pictures::base64(&preview))),
    })
}

fn tiff_orientation(data: &[u8]) -> Result<u8, String> {
    let invalid = || "figure EXIF orientation is unreadable".to_string();
    let little = match data.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Err(invalid()),
    };
    let u16_at = |at: usize| -> Option<u16> {
        let bytes = data.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let bytes = data.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    if u16_at(2) != Some(42) {
        return Err(invalid());
    }
    let offset = u32_at(4).ok_or_else(invalid)? as usize;
    let count = u16_at(offset).ok_or_else(invalid)? as usize;
    for i in 0..count {
        let at = offset.checked_add(2 + i * 12).ok_or_else(invalid)?;
        let tag = u16_at(at).ok_or_else(invalid)?;
        if data.get(at..at + 12).is_none() {
            return Err(invalid());
        }
        if tag == 0x112 {
            if u16_at(at + 2) != Some(3) || u32_at(at + 4) != Some(1) {
                return Err(invalid());
            }
            let value = u16_at(at + 8).ok_or_else(invalid)?;
            return if (1..=8).contains(&value) {
                Ok(value as u8)
            } else {
                Err(invalid())
            };
        }
    }
    Ok(1)
}

pub(crate) fn orientation(data: &[u8], format: pictures::Format) -> Result<u8, String> {
    match format {
        pictures::Format::Png => {
            let mut at = 8;
            while let Some(chunk) = data.get(at..at + 8) {
                let len = u32::from_be_bytes(chunk[..4].try_into().unwrap()) as usize;
                let end = at
                    .checked_add(12)
                    .and_then(|v| v.checked_add(len))
                    .ok_or("figure PNG chunk exceeds bounds")?;
                if end > data.len() {
                    return Err("figure PNG chunk is truncated".into());
                }
                if &chunk[4..8] == b"eXIf" {
                    return tiff_orientation(&data[at + 8..end - 4]);
                }
                at = end;
            }
        }
        pictures::Format::Jpeg => {
            let mut at = 2;
            while data.get(at) == Some(&0xff) {
                while data.get(at) == Some(&0xff) {
                    at += 1;
                }
                let marker = *data.get(at).ok_or("figure JPEG marker is truncated")?;
                at += 1;
                if matches!(marker, 0xda | 0xd9) {
                    break;
                }
                if matches!(marker, 0x01 | 0xd0..=0xd8) {
                    continue;
                }
                let length = data
                    .get(at..at + 2)
                    .ok_or("figure JPEG segment is truncated")?;
                let len = u16::from_be_bytes(length.try_into().unwrap()) as usize;
                if len < 2 {
                    return Err("figure JPEG segment is invalid".into());
                }
                let end = at
                    .checked_add(len)
                    .ok_or("figure JPEG segment exceeds bounds")?;
                let segment = data
                    .get(at + 2..end)
                    .ok_or("figure JPEG segment is truncated")?;
                if marker == 0xe1 && segment.starts_with(b"Exif\0\0") {
                    return tiff_orientation(&segment[6..]);
                }
                at = end;
            }
        }
    }
    Ok(1)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn import(db: &Path, store: &Store, source: &Path) -> FigureAsset {
        import_original(db, source, |asset| {
            crate::store::figure_assets::test_support::register(store, asset)
        })
        .unwrap()
    }
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
#[path = "figures/review_tests.rs"]
mod review_tests;
