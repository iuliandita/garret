//! Explicit, reviewable transfer of book design between projects.

use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::Store;

pub const KEYS: [&str; 7] = [
    crate::design::FONT_KEY,
    crate::design::PAGE_KEY,
    crate::design::MARGINS_KEY,
    crate::design::GLYPH_KEY,
    crate::design::CHAPTER_KEY,
    crate::covers::FRONT_FIT_KEY,
    crate::covers::BACK_FIT_KEY,
];
const NAMES: [&str; 7] = [
    "font",
    "page",
    "margins",
    "glyph",
    "chapter",
    "cover_fit_front",
    "cover_fit_back",
];
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub field: &'static str,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub source: &'static str,
    pub token: String,
    pub changes: Vec<Change>,
    pub skipped: Vec<Skipped>,
    pub note: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    pub field: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone)]
struct Candidate {
    source: &'static str,
    // None means salvage could not establish a value; Some(None) is a
    // sidecar's explicit instruction to remove the target key.
    values: Vec<Option<Option<String>>>,
    skipped: Vec<Skipped>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sidecar {
    version: u64,
    values: SidecarValues,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarValues {
    font: serde_json::Value,
    page: serde_json::Value,
    margins: serde_json::Value,
    glyph: serde_json::Value,
    chapter: serde_json::Value,
    cover_fit_front: serde_json::Value,
    cover_fit_back: serde_json::Value,
}

fn read_source(path: &Path) -> Result<Vec<u8>, String> {
    let file = crate::backup_bundle::open_regular_with_limit(path, MAX_SOURCE_BYTES)
        .map_err(|e| format!("design source {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("design source unreadable: {e}"))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err("design source too large".into());
    }
    Ok(bytes)
}

fn value_for(value: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| format!("{key} must be a string or null"))
}

fn valid(key: &str, raw: &str) -> Result<String, &'static str> {
    match key {
        crate::design::FONT_KEY => crate::design::parse_font(raw)
            .filter(|font| font == raw)
            .ok_or("invalid_font"),
        crate::design::PAGE_KEY => crate::design::parse_page(raw)
            .map(|page| crate::design::format_page(&page))
            .filter(|page| page == raw)
            .ok_or("invalid_page"),
        crate::design::MARGINS_KEY => crate::design::parse_margins(raw)
            .map(|margins| crate::design::format_margins(&margins))
            .filter(|margins| margins == raw)
            .ok_or("invalid_margins"),
        crate::design::GLYPH_KEY => {
            if raw.is_empty() || crate::design::glyph_ornament(raw).is_some() {
                Ok(raw.to_string())
            } else {
                Err("unknown_ornament")
            }
        }
        crate::design::CHAPTER_KEY => {
            let mut found = std::collections::BTreeSet::new();
            for flag in raw.split_whitespace() {
                if !matches!(
                    flag,
                    crate::design::NEW_PAGE | crate::design::CAPS_TITLE | crate::design::DROP_CAP
                ) || !found.insert(flag)
                {
                    return Err("invalid_chapter_option");
                }
            }
            Ok(raw.to_string())
        }
        crate::covers::FRONT_FIT_KEY | crate::covers::BACK_FIT_KEY => {
            crate::covers::CoverFit::from_id(raw)
                .map(|fit| fit.id().to_string())
                .ok_or("unknown_cover_fit")
        }
        _ => Err("unknown_design_field"),
    }
}

fn candidate(bytes: &[u8]) -> Result<Candidate, String> {
    let root: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("design source is not JSON: {e}"))?;
    let obj = root.as_object().ok_or("design source must be an object")?;
    if obj.contains_key("version") {
        let strict: Sidecar = serde_json::from_slice(bytes)
            .map_err(|e| format!("malformed book-design file: {e}"))?;
        if strict.version != 1 {
            return Err("unsupported or malformed book-design file".into());
        }
        let values = [
            strict.values.font, strict.values.page, strict.values.margins,
            strict.values.glyph, strict.values.chapter,
            strict.values.cover_fit_front, strict.values.cover_fit_back,
        ];
        let mut selected = Vec::with_capacity(KEYS.len());
        for ((key, name), value) in KEYS.iter().zip(NAMES).zip(values.iter()) {
            let raw = value_for(value, name)?;
            selected.push(Some(
                raw.map(|v| valid(key, &v).map_err(|reason| format!("{name}: {reason}")))
                    .transpose()?,
            ));
        }
        return Ok(Candidate {
            source: "book-design",
            values: selected,
            skipped: Vec::new(),
        });
    }
    let Some(meta) = obj.get("meta").and_then(serde_json::Value::as_object) else {
        return Err(
            "source is neither a book-design file nor a salvage manifest with readable meta".into(),
        );
    };
    let projected = obj
        .get("design")
        .and_then(serde_json::Value::as_object)
        .ok_or("salvage manifest has no design projection")?;
    let losses = obj
        .get("losses")
        .and_then(serde_json::Value::as_array)
        .ok_or("salvage manifest has no loss list")?;
    let meta_uncertain = losses.iter().any(|loss| {
        matches!(
            loss.get("kind").and_then(serde_json::Value::as_str),
            Some(
                "table_unreadable"
                    | "enumeration_stopped"
                    | "unreadable_meta_row"
                    | "unreadable_design_row"
            )
        )
    });
    let mut selected = Vec::with_capacity(KEYS.len());
    let mut skipped = Vec::new();
    for (index, (key, name)) in KEYS.iter().zip(NAMES).enumerate() {
        let raw = meta.get(*key);
        if index < 5 || raw.is_some() || projected.contains_key(name) {
            let projected_raw = projected
                .get(name)
                .ok_or("salvage design projection incomplete")?;
            let expected = raw
                .and_then(serde_json::Value::as_str)
                .filter(|v| !v.is_empty());
            if projected_raw.as_str() != expected
                && !(projected_raw.is_null() && expected.is_none())
            {
                return Err(format!("salvage design projection disagrees with {key}"));
            }
        }
        match raw {
            Some(value) => {
                let Some(text) = value.as_str() else {
                    skipped.push(Skipped {
                        field: name,
                        reason: "unreadable",
                    });
                    selected.push(None);
                    continue;
                };
                match valid(key, text) {
                    Ok(normalized) => selected.push(Some(Some(normalized))),
                    Err(reason) => {
                        skipped.push(Skipped {
                            field: name,
                            reason,
                        });
                        selected.push(None);
                    }
                }
            }
            None => {
                skipped.push(Skipped {
                    field: name,
                    reason: if meta_uncertain {
                        "absent_or_unrecovered"
                    } else if index >= 5 {
                        "legacy_or_not_chosen"
                    } else {
                        "not_chosen"
                    },
                });
                selected.push(None);
            }
        }
    }
    if selected.iter().all(Option::is_none) {
        return Err("salvage manifest has no validated design choice to apply".into());
    }
    Ok(Candidate {
        source: "salvage",
        values: selected,
        skipped,
    })
}

fn raw_values(store: &Store) -> Result<Vec<Option<String>>, String> {
    KEYS.iter()
        .map(|key| store.get_meta(key).map_err(|e| e.to_string()))
        .collect()
}

fn token(
    store: &Store,
    destination: &Path,
    bytes: &[u8],
    current: &[Option<String>],
    generation: u64,
) -> Result<String, String> {
    let path = fs::canonicalize(destination)
        .map_err(|_| "receiving book path is unavailable".to_string())?;
    let book_id = store.book_id().map_err(|e| e.to_string())?;
    let identity = serde_json::to_vec(&book_id).map_err(|e| e.to_string())?;
    let path_bytes = path.as_os_str().as_encoded_bytes();
    let mut hash = Sha256::new();
    hash.update(b"book-design-transfer-v2");
    hash.update((identity.len() as u64).to_le_bytes());
    hash.update(identity);
    hash.update((path_bytes.len() as u64).to_le_bytes());
    hash.update(path_bytes);
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    hash.update(serde_json::to_vec(current).map_err(|e| e.to_string())?);
    hash.update(generation.to_le_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

fn effective(store: &Store, values: &[Option<Option<String>>]) -> Result<(), String> {
    let mut design = crate::design::design_of(store)?;
    let defaults = crate::design::default_design();
    if let Some(raw) = &values[0] {
        design.font = raw
            .as_deref()
            .and_then(crate::design::parse_font)
            .unwrap_or(defaults.font);
    }
    if let Some(raw) = &values[1] {
        design.page = raw
            .as_deref()
            .and_then(crate::design::parse_page)
            .unwrap_or(defaults.page);
    }
    if let Some(raw) = &values[2] {
        design.margins = raw
            .as_deref()
            .and_then(crate::design::parse_margins)
            .unwrap_or(defaults.margins);
    }
    crate::design::check(&design)
}

pub fn preview(store: &Store, destination: &Path, source: &Path, generation: u64) -> Result<Preview, String> {
    let bytes = read_source(source)?;
    let candidate = candidate(&bytes)?;
    effective(store, &candidate.values)?;
    let current = raw_values(store)?;
    let changes = candidate
        .values
        .iter()
        .enumerate()
        .filter_map(|(i, selected)| {
            selected
                .as_ref()
                .filter(|next| *next != &current[i])
                .map(|next| Change {
                    field: NAMES[i],
                    before: current[i].clone(),
                    after: next.clone(),
                })
        })
        .collect();
    Ok(Preview {
        source: candidate.source,
        token: token(store, destination, &bytes, &current, generation)?,
        changes,
        skipped: candidate.skipped,
        note: "Font names transfer without font files. Cover placement transfers without pictures.",
    })
}

pub fn apply(
    store: &Store,
    destination: &Path,
    source: &Path,
    generation: u64,
    expected: &str,
) -> Result<Preview, String> {
    let reviewed = preview(store, destination, source, generation)?;
    let bytes = read_source(source)?;
    let candidate = candidate(&bytes)?;
    store.with_immediate(|store| {
        let before = raw_values(store)?;
        if token(store, destination, &bytes, &before, generation)? != expected {
            return Err(
                "design preview is stale; preview the source and receiving book again".into(),
            );
        }
        effective(store, &candidate.values)?;
        for (key, selected) in KEYS.iter().zip(&candidate.values) {
            match selected {
                Some(Some(value)) => store.set_meta(key, value).map_err(|e| e.to_string())?,
                Some(None) => store.delete_meta(key).map_err(|e| e.to_string())?,
                None => {}
            }
        }
        Ok(())
    })?;
    Ok(reviewed)
}

pub fn export(store: &Store, dest: &Path) -> Result<(), String> {
    let raw = raw_values(store)?;
    for (key, value) in KEYS.iter().zip(&raw) {
        if let Some(value) = value {
            valid(key, value).map_err(|e| format!("{key}: {e}"))?;
        }
    }
    effective(store, &raw.iter().cloned().map(Some).collect::<Vec<_>>())?;
    let values: serde_json::Map<String, serde_json::Value> = NAMES
        .iter()
        .zip(raw)
        .map(|(name, value)| {
            (
                name.to_string(),
                match value {
                    Some(raw) => serde_json::Value::String(raw),
                    None => serde_json::Value::Null,
                },
            )
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({"version": 1, "values": values}))
        .map_err(|e| e.to_string())?;
    publish_with(dest, |stage| stage.write_all(&bytes))
}

fn publish_with(
    dest: &Path,
    write: impl FnOnce(&mut tempfile::NamedTempFile) -> io::Result<()>,
) -> Result<(), String> {
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut stage = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("book-design destination unavailable: {e}"))?;
    write(&mut stage).map_err(|e| format!("book-design write failed: {e}"))?;
    stage.as_file().sync_all().map_err(|e| format!("book-design sync failed: {e}"))?;
    stage.persist_noclobber(dest)
        .map_err(|e| format!("book-design destination unavailable or already exists: {}", e.error))?;
    crate::backup_bundle::sync_directory(parent)
        .map_err(|e| format!("book-design file was published and retained, but {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sidecar_round_trip_preserves_absence_and_requires_fresh_target() {
        let dir = tempdir().unwrap();
        let source = Store::open(&dir.path().join("source.db")).unwrap();
        source
            .set_meta(crate::design::FONT_KEY, "Crimson Text")
            .unwrap();
        source
            .set_meta(crate::covers::FRONT_FIT_KEY, "fill")
            .unwrap();
        let file = dir.path().join("style.book-design.json");
        export(&source, &file).unwrap();
        let bytes = fs::read(&file).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("source.db"));
        assert!(export(&source, &file).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);

        let target_path = dir.path().join("target.db");
        let target = Store::open(&target_path).unwrap();
        target
            .set_meta(crate::design::PAGE_KEY, "148000x210000 a5")
            .unwrap();
        let first = preview(&target, &target_path, &file, 17).unwrap();
        assert!(first
            .changes
            .iter()
            .any(|c| c.field == "page" && c.after.is_none()));
        assert!(apply(&target, &target_path, &file, 18, &first.token).is_err());
        target
            .set_meta(crate::design::GLYPH_KEY, "fleuron")
            .unwrap();
        assert!(apply(&target, &target_path, &file, 17, &first.token).is_err());
        assert_eq!(
            target.get_meta(crate::design::PAGE_KEY).unwrap().as_deref(),
            Some("148000x210000 a5")
        );
        let fresh = preview(&target, &target_path, &file, 17).unwrap();
        apply(&target, &target_path, &file, 17, &fresh.token).unwrap();
        assert_eq!(target.get_meta(crate::design::PAGE_KEY).unwrap(), None);
        assert_eq!(target.get_meta(crate::design::GLYPH_KEY).unwrap(), None);
        assert_eq!(
            target
                .get_meta(crate::covers::FRONT_FIT_KEY)
                .unwrap()
                .as_deref(),
            Some("fill")
        );
    }

    #[test]
    fn source_change_and_invalid_combination_leave_target_untouched() {
        let dir = tempdir().unwrap();
        let source = Store::open(&dir.path().join("source.db")).unwrap();
        let file = dir.path().join("style.book-design.json");
        export(&source, &file).unwrap();
        let target_path = dir.path().join("target.db");
        let target = Store::open(&target_path).unwrap();
        let token = preview(&target, &target_path, &file, 1).unwrap().token;
        let mut text = fs::read_to_string(&file).unwrap();
        text.push(' ');
        fs::write(&file, text).unwrap();
        assert!(apply(&target, &target_path, &file, 1, &token).is_err());
        assert_eq!(target.get_meta(crate::design::FONT_KEY).unwrap(), None);
        fs::write(
            &file,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "values": {
                    "font": "Crimson Text", "page": "10000x10000", "margins": "9000,9000,9000,9000",
                    "glyph": null, "chapter": null, "cover_fit_front": null, "cover_fit_back": null
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(preview(&target, &target_path, &file, 1).is_err());
        assert_eq!(target.get_meta(crate::design::FONT_KEY).unwrap(), None);
    }

    #[test]
    fn a_preview_token_cannot_apply_to_another_receiving_book() {
        let dir = tempdir().unwrap();
        let source = Store::open(&dir.path().join("source.db")).unwrap();
        source.set_meta(crate::design::FONT_KEY, "EB Garamond").unwrap();
        let file = dir.path().join("style.book-design.json");
        export(&source, &file).unwrap();
        let first_path = dir.path().join("first.db");
        let second_path = dir.path().join("second.db");
        let first = Store::open(&first_path).unwrap();
        let second = Store::open(&second_path).unwrap();
        assert_eq!(raw_values(&first).unwrap(), raw_values(&second).unwrap());
        let reviewed = preview(&first, &first_path, &file, 0).unwrap();
        assert_ne!(reviewed.token, preview(&second, &second_path, &file, 0).unwrap().token);
        assert!(apply(&second, &second_path, &file, 0, &reviewed.token).is_err());
        assert_eq!(second.get_meta(crate::design::FONT_KEY).unwrap(), None);
    }

    #[test]
    fn a_failed_staged_write_leaves_no_final_and_an_existing_final_is_never_replaced() {
        let dir = tempdir().unwrap();
        let dest = dir.path().join("style.book-design.json");
        let before = fs::read_dir(dir.path()).unwrap().count();
        let result = publish_with(&dest, |stage| {
            stage.write_all(b"partial")?;
            Err(io::Error::other("injected write failure"))
        });
        assert!(result.unwrap_err().contains("write failed"));
        assert!(!dest.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
        fs::write(&dest, b"existing").unwrap();
        assert!(publish_with(&dest, |stage| stage.write_all(b"replacement")).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"existing");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before + 1);
    }

    #[test]
    fn salvage_applies_only_readable_present_choices() {
        let dir = tempdir().unwrap();
        let target_path = dir.path().join("target.db");
        let target = Store::open(&target_path).unwrap();
        target
            .set_meta(crate::design::FONT_KEY, "EB Garamond")
            .unwrap();
        target
            .set_meta(crate::design::GLYPH_KEY, "fleuron")
            .unwrap();
        let file = dir.path().join("manifest.json");
        let manifest = serde_json::json!({
            "meta": { "design.chapter": "", "design.page": "148000x210000 a5", "design.glyph": "unknown" },
            "design": {"font": null, "page": "148000x210000 a5", "margins": null,
                "glyph": "unknown", "chapter": null},
            "losses": [{"kind": "unreadable_meta_row", "detail": "meta row could not be read", "item_id": null}]
        });
        fs::write(&file, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let before = fs::read(&file).unwrap();
        let seen = preview(&target, &target_path, &file, 3).unwrap();
        assert_eq!(seen.source, "salvage");
        assert!(seen
            .skipped
            .iter()
            .any(|s| s.field == "glyph" && s.reason == "unknown_ornament"));
        assert!(seen
            .skipped
            .iter()
            .any(|s| s.field == "font" && s.reason == "absent_or_unrecovered"));
        apply(&target, &target_path, &file, 3, &seen.token).unwrap();
        assert_eq!(
            target.get_meta(crate::design::FONT_KEY).unwrap().as_deref(),
            Some("EB Garamond")
        );
        assert_eq!(
            target.get_meta(crate::design::PAGE_KEY).unwrap().as_deref(),
            Some("148000x210000 a5")
        );
        assert_eq!(
            target
                .get_meta(crate::design::CHAPTER_KEY)
                .unwrap()
                .as_deref(),
            Some("")
        );
        assert_eq!(
            target
                .get_meta(crate::design::GLYPH_KEY)
                .unwrap()
                .as_deref(),
            Some("fleuron")
        );
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn sidecar_refuses_duplicate_and_unknown_fields() {
        let duplicate = br#"{"version":1,"values":{"font":null,"font":"Crimson Text","page":null,"margins":null,"glyph":null,"chapter":null,"cover_fit_front":null,"cover_fit_back":null}}"#;
        assert!(candidate(duplicate).unwrap_err().contains("duplicate field"));
        let unknown = br#"{"version":1,"values":{"font":null,"page":null,"margins":null,"glyph":null,"chapter":null,"cover_fit_front":null,"cover_fit_back":null,"invented":null}}"#;
        assert!(candidate(unknown).unwrap_err().contains("unknown field"));
        let newer = br#"{"version":2,"values":{"font":null,"page":null,"margins":null,"glyph":null,"chapter":null,"cover_fit_front":null,"cover_fit_back":null}}"#;
        assert!(candidate(newer).unwrap_err().contains("unsupported"));
    }

    #[test]
    fn salvage_fit_projection_must_agree_with_raw_meta() {
        let source = serde_json::json!({
            "meta": {"design.cover-fit.front": "fill"},
            "design": {"font":null,"page":null,"margins":null,"glyph":null,"chapter":null,"cover_fit_front":"contain"},
            "losses": []
        });
        let bytes = serde_json::to_vec(&source).unwrap();
        assert!(candidate(&bytes).unwrap_err().contains("disagrees"));
    }

    #[cfg(unix)]
    #[test]
    fn source_symlink_is_not_a_design_file() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.json");
        fs::write(&real, b"{}").unwrap();
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(read_source(&link).is_err());
        assert_eq!(fs::read(&real).unwrap(), b"{}");
    }
}
