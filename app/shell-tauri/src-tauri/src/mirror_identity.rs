//! Identity disclosure for the readable mirror. The private vault stays in the
//! host; the page receives findings and an opaque confirmation handle only.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{identity, mirror, mirror_wordlist, store};

pub const RECORD_NAME: &str = ".readable-mirror-identity.json";
const RECORD_VERSION: u8 = 2;
const RECORD_MAX_BYTES: u64 = 4096;

pub fn is_reserved(rel: &str) -> bool {
    rel == RECORD_NAME
        || rel
            .strip_prefix(&format!("{RECORD_NAME}."))
            .and_then(|name| name.strip_suffix(".tmp"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

/// Resolve the physical existing prefix without creating the destination.
/// This makes a repointed symlink invalidate a preview before any write.
fn actual_destination(dir: &Path) -> Result<PathBuf, String> {
    let absolute = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(dir)
    };
    let mut tail = Vec::new();
    let mut cursor = absolute.as_path();
    loop {
        match std::fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for part in tail.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    cursor
                        .file_name()
                        .ok_or("mirror destination has no usable name")?,
                );
                cursor = cursor.parent().ok_or("mirror destination has no parent")?;
            }
            Err(error) => return Err(format!("mirror destination cannot be resolved: {error}")),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Preview {
    pub token: Option<String>,
    pub dir: String,
    pub check_state: &'static str,
    pub pin_state: &'static str,
    pub findings: Vec<identity::Finding>,
    pub files: usize,
    pub scope: Vec<&'static str>,
    pub limits: Vec<&'static str>,
}

pub struct Captured {
    pub preview: Preview,
    pub digest: [u8; 32],
    pub hashes: Vec<(String, String)>,
    pub wordlist_hash: String,
}

/// Read only what a mirror pass projects. `file_body` and `layout` are the
/// writer's own rendering and naming rules; the shared identity check supplies
/// folding, aliases, and literal offsets.
pub fn capture(
    source: &Path,
    expected_book_id: &str,
    name: &str,
    dir: &Path,
    data_home: &Path,
) -> Result<Captured, String> {
    let actual_dir = actual_destination(dir)?;
    let store = store::Store::open_readonly(source).map_err(|e| e.to_string())?;
    if store.book_id().map_err(|e| e.to_string())?.as_deref() != Some(expected_book_id) {
        return Err("the source book changed; preview the readable folder again".into());
    }
    let items = store::manuscript_items(store.items().map_err(|e| e.to_string())?);
    let bodies = store.documents().map_err(|e| e.to_string())?;
    let words = store
        .dict_words()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|word| word.word)
        .collect::<Vec<_>>();
    let wordlist = mirror_wordlist::render(&words)?;
    let pin = identity::pin_of_project(&store)?;
    let vault = identity::read_vault(data_home).map_err(|e| e.to_string())?;
    let pin_state = match pin.as_ref() {
        None => "unset",
        Some(pin)
            if vault
                .identities
                .iter()
                .any(|identity| identity.id == pin.identity_id && identity.rev > pin.rev) =>
        {
            "stale"
        }
        Some(_) => "pinned",
    };
    let rendered: Vec<(String, String)> = items
        .iter()
        .zip(mirror::layout(&items))
        .map(|(item, place)| {
            (
                place.path,
                mirror::file_body(item, bodies.get(&item.id).map(String::as_str)),
            )
        })
        .collect();
    let hashes = rendered
        .iter()
        .map(|(path, body)| {
            (
                path.clone(),
                format!("{:016x}", store::history::hash64(body.as_bytes())),
            )
        })
        .collect();
    let projected = rendered
        .iter()
        .map(|(path, body)| (path.as_str(), body.clone()))
        .collect::<Vec<_>>();
    let mut planning = vec![
        identity::PlanningText {
            surface: "mirror_wordlist",
            item_id: Some(mirror_wordlist::WORDLIST_NAME.to_string()),
            text: wordlist.clone(),
        },
        identity::PlanningText {
            surface: "mirror_destination",
            item_id: None,
            text: actual_dir.display().to_string(),
        },
        identity::PlanningText {
            surface: "mirror_manifest_slug",
            item_id: None,
            text: crate::recovery::target_slug(Some(source), None, None)
                .ok_or("book has no usable file name")?,
        },
    ];
    planning.extend(rendered.iter().map(|(path, _)| identity::PlanningText {
        surface: "mirror_path",
        item_id: Some(path.clone()),
        text: path.clone(),
    }));
    let checked = identity::check(&identity::Subject {
        format: crate::export::Format::Markdown,
        project_name: name,
        titles: &[],
        bodies: &projected,
        planning: &planning,
        pin: pin.as_ref(),
        vault: &vault,
    });
    let check_state = checked
        .checks
        .iter()
        .find(|check| check.name == identity::CHECK_CROSS_IDENTITY)
        .map(|check| check.state)
        .ok_or("identity check did not answer")?;
    let findings = checked
        .findings
        .into_iter()
        .filter(|finding| {
            finding.kind == identity::FINDING_CROSS_IDENTITY
                || finding.kind == identity::FINDING_CROSS_IDENTITY_UNPINNED
        })
        .collect();
    let fingerprint = serde_json::to_vec(&(
        expected_book_id,
        name,
        actual_dir.display().to_string(),
        &rendered,
        &wordlist,
        &pin,
        &vault,
    ))
    .map_err(|e| e.to_string())?;
    let digest: [u8; 32] = Sha256::digest(fingerprint).into();
    Ok(Captured {
        preview: Preview {
            token: None,
            dir: actual_dir.display().to_string(),
            check_state,
            pin_state,
            findings,
            files: rendered.len(),
            scope: vec!["destination", "project_name", "markdown", "wordlist"],
            limits: vec!["known_names", "excluded", "external"],
        },
        digest,
        hashes,
        wordlist_hash: format!("{:016x}", store::history::hash64(wordlist.as_bytes())),
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    generated_at: i64,
    manifest_digest: String,
    /// One-way binding to the rendered book and current vault/pin; no vault values travel.
    content_digest: [u8; 32],
    state: String,
    location: Option<String>,
}

fn manifest_digest(manifest: &crate::recovery::Manifest<mirror::MirrorEntry>) -> Option<String> {
    let bytes = serde_json::to_vec(manifest).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

/// The report is deliberately a class and location, never a copied vault name.
/// Missing, malformed, or older records mean unavailable, not a clean check.
pub fn reported(
    dir: &Path,
    manifest: Option<&crate::recovery::Manifest<mirror::MirrorEntry>>,
    content_digest: Option<[u8; 32]>,
) -> (&'static str, Option<String>) {
    let (Some(manifest), Some(content_digest)) = (manifest, content_digest) else {
        return ("unavailable", None);
    };
    let path = dir.join(RECORD_NAME);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return ("unavailable", None);
    };
    if !meta.file_type().is_file() || meta.len() > RECORD_MAX_BYTES {
        return ("unavailable", None);
    }
    let Ok(file) = std::fs::File::open(path) else {
        return ("unavailable", None);
    };
    let mut bytes = Vec::new();
    use std::io::Read as _;
    if file
        .take(RECORD_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > RECORD_MAX_BYTES
    {
        return ("unavailable", None);
    };
    let Ok(record) = serde_json::from_slice::<Record>(&bytes) else {
        return ("unavailable", None);
    };
    if record.version != RECORD_VERSION
        || record.generated_at != manifest.generated_at
        || manifest_digest(manifest).as_deref() != Some(record.manifest_digest.as_str())
        || record.content_digest != content_digest
    {
        return ("unavailable", None);
    }
    match record.state.as_str() {
        "finding" if record.location.as_deref().is_some_and(safe_location) => {
            ("finding", record.location)
        }
        "clear" if record.location.is_none() => ("clear", None),
        "not_applicable" if record.location.is_none() => ("not_applicable", None),
        _ => ("unavailable", None),
    }
}

fn safe_location(location: &str) -> bool {
    !location.is_empty()
        && location.len() <= 2048
        && !location.starts_with('/')
        && !location.contains('\\')
        && !location.contains(':')
        && !location.chars().any(char::is_control)
        && location
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn record_after_pass(
    dir: &Path,
    generated_at: i64,
    result: Result<&Captured, String>,
    report: &mirror::PassReport,
) -> Result<(), String> {
    let manifest: Option<crate::recovery::Manifest<mirror::MirrorEntry>> =
        crate::recovery::read_manifest(dir);
    let manifest_matches = manifest.as_ref().is_some_and(|manifest| {
        manifest.generated_at == generated_at && manifest.entries == report.entries
    });
    let entries = &report.entries;
    let expected: std::collections::HashMap<&str, &str> = entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.hash.as_str()))
        .collect();
    let valid = result.ok().filter(|captured| {
        !report.paused
            && manifest_matches
            && matches!(
                captured.preview.check_state,
                identity::STATE_RAN | identity::STATE_NOT_APPLICABLE
            )
            && report.wordlist_hash.as_deref() == Some(captured.wordlist_hash.as_str())
            && expected.len() == entries.len()
            && captured.hashes.len() == entries.len()
            && captured
                .hashes
                .iter()
                .all(|(path, hash)| expected.get(path.as_str()) == Some(&hash.as_str()))
    });
    let found = valid.is_some_and(|captured| !captured.preview.findings.is_empty());
    let location = valid
        .and_then(|captured| captured.preview.findings.first())
        .map(|finding| {
            finding
                .item_id
                .clone()
                .unwrap_or_else(|| finding.surface.to_string())
        })
        .filter(|location| safe_location(location));
    let state = if valid.is_none() || (found && location.is_none()) {
        "unavailable"
    } else if location.is_some() {
        "finding"
    } else if valid
        .is_some_and(|captured| captured.preview.check_state == identity::STATE_NOT_APPLICABLE)
    {
        "not_applicable"
    } else {
        "clear"
    };
    let record = Record {
        version: RECORD_VERSION,
        generated_at,
        manifest_digest: manifest
            .as_ref()
            .and_then(manifest_digest)
            .unwrap_or_default(),
        content_digest: valid.map(|captured| captured.digest).unwrap_or_default(),
        state: state.into(),
        location,
    };
    let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("{RECORD_NAME}.{}.tmp", uuid::Uuid::now_v7()));
    let dest = dir.join(RECORD_NAME);
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("identity disclosure record unavailable: {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("identity disclosure record unavailable: {e}"))?;
    std::fs::rename(&temp, &dest)
        .map_err(|e| format!("identity disclosure record unavailable: {e}"))?;
    crate::backup_bundle::sync_directory(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{FlushEntry, Store};

    fn reported_current(dir: &Path, digest: [u8; 32]) -> (&'static str, Option<String>) {
        let manifest = crate::recovery::read_manifest(dir);
        reported(dir, manifest.as_ref(), Some(digest))
    }

    fn seeded(db: &Path, home: &Path) -> String {
        let store = Store::open(db).unwrap();
        let id = store.book_id().unwrap().unwrap();
        let scene = store.item_create(None, "scene", "A meeting").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: scene.id,
                body: crate::test_support::body("The Shadow Name arrived."),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        store.dict_add("Shadow Name").unwrap();
        let mine = identity::Identity {
            id: "mine".into(),
            rev: 1,
            public: identity::Public {
                name: "Ada Vane".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let other = identity::Identity {
            id: "other".into(),
            rev: 1,
            public: identity::Public {
                name: "Bram Kell".into(),
                ..Default::default()
            },
            aliases: vec!["Shadow Name".into()],
            ..Default::default()
        };
        identity::set_pin(&store, Some(&identity::pin_of(&mine, 1))).unwrap();
        identity::write_vault(
            home,
            &identity::Vault {
                version: identity::VAULT_VERSION,
                identities: vec![mine, other],
            },
        )
        .unwrap();
        id
    }

    #[test]
    fn preview_uses_the_shared_alias_matcher_over_rendered_prose_and_wordlist_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        let dir = temp.path().join("mirror");
        let captured = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        assert_eq!(captured.preview.check_state, identity::STATE_RAN);
        assert!(captured.preview.findings.iter().any(|finding| {
            finding.matched == "Shadow Name"
                && finding
                    .item_id
                    .as_deref()
                    .is_some_and(|at| at.ends_with("A-meeting.md"))
        }));
        assert!(captured.preview.findings.iter().any(|finding| {
            finding.matched == "Shadow Name" && finding.surface == "mirror_wordlist"
        }));
        assert!(
            !dir.exists(),
            "a canceled preview may not create mirror files"
        );
        let different_destination = capture(
            &db,
            &id,
            "A Novel",
            &temp.path().join("elsewhere"),
            temp.path(),
        )
        .unwrap();
        assert_ne!(captured.digest, different_destination.digest);
        Store::open(&db).unwrap().dict_add("Another Word").unwrap();
        let changed_content = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        assert_ne!(captured.digest, changed_content.digest);
        let mut vault = identity::read_vault(temp.path()).unwrap();
        vault.identities[1].aliases.push("Another Alias".into());
        identity::write_vault(temp.path(), &vault).unwrap();
        assert_ne!(
            changed_content.digest,
            capture(&db, &id, "A Novel", &dir, temp.path())
                .unwrap()
                .digest
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_repointed_destination_symlink_invalidates_the_preview() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let link = temp.path().join("chosen");
        symlink(&first, &link).unwrap();
        let path = link.join("book");
        let before = capture(&db, &id, "A Novel", &path, temp.path()).unwrap();
        assert_eq!(before.preview.dir, first.join("book").display().to_string());
        std::fs::remove_file(&link).unwrap();
        symlink(&second, &link).unwrap();
        let after = capture(&db, &id, "A Novel", &path, temp.path()).unwrap();
        assert_eq!(after.preview.dir, second.join("book").display().to_string());
        assert_ne!(before.digest, after.digest);
        assert!(!first.join("book").exists() && !second.join("book").exists());
    }

    #[test]
    fn a_persisted_finding_survives_restart_and_missing_or_stale_records_are_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        let dir = temp.path().join("mirror");
        let pass =
            mirror::pass_for_book(&db, &id, "book", "A Novel", &dir, 42, &Default::default())
                .unwrap();
        let captured = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        record_after_pass(&dir, 42, Ok(&captured), &pass).unwrap();
        assert_eq!(reported_current(&dir, captured.digest).0, "finding");
        assert!(reported_current(&dir, captured.digest)
            .1
            .unwrap()
            .ends_with("A-meeting.md"));
        let mut later: crate::recovery::Manifest<mirror::MirrorEntry> =
            crate::recovery::read_manifest(&dir).unwrap();
        later.generated_at = 43;
        assert_eq!(
            reported(&dir, Some(&later), Some(captured.digest)),
            ("unavailable", None)
        );
        std::fs::write(dir.join(RECORD_NAME), b"{").unwrap();
        assert_eq!(
            reported_current(&dir, captured.digest),
            ("unavailable", None)
        );
        std::fs::write(dir.join(RECORD_NAME), b"{\"version\":1,\"generated_at\":42,\"state\":\"finding\",\"location\":\"/private/path\"}").unwrap();
        assert_eq!(
            reported_current(&dir, captured.digest),
            ("unavailable", None)
        );
        record_after_pass(&dir, 44, Err("unreadable vault".into()), &pass).unwrap();
        assert_eq!(
            reported_current(&dir, captured.digest),
            ("unavailable", None)
        );
    }

    #[test]
    fn no_comparison_names_is_recorded_without_claiming_a_clear_check() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        identity::write_vault(
            temp.path(),
            &identity::Vault {
                version: identity::VAULT_VERSION,
                identities: Vec::new(),
            },
        )
        .unwrap();
        let dir = temp.path().join("mirror");
        let pass =
            mirror::pass_for_book(&db, &id, "book", "A Novel", &dir, 42, &Default::default())
                .unwrap();
        let captured = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        assert_eq!(captured.preview.check_state, identity::STATE_NOT_APPLICABLE);
        record_after_pass(&dir, 42, Ok(&captured), &pass).unwrap();
        assert_eq!(
            reported_current(&dir, captured.digest),
            ("not_applicable", None)
        );
    }

    #[test]
    fn a_clear_record_is_unavailable_after_manifest_or_vault_changes() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        let mut vault = identity::read_vault(temp.path()).unwrap();
        vault.identities[1].aliases.clear();
        identity::write_vault(temp.path(), &vault).unwrap();
        let dir = temp.path().join("mirror");
        let pass =
            mirror::pass_for_book(&db, &id, "book", "A Novel", &dir, 42, &Default::default())
                .unwrap();
        let captured = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        record_after_pass(&dir, 42, Ok(&captured), &pass).unwrap();
        assert_eq!(reported_current(&dir, captured.digest), ("clear", None));

        let mut changed_manifest: crate::recovery::Manifest<mirror::MirrorEntry> =
            crate::recovery::read_manifest(&dir).unwrap();
        changed_manifest.entries[0].hash.push('0');
        assert_eq!(
            reported(&dir, Some(&changed_manifest), Some(captured.digest)),
            ("unavailable", None)
        );

        vault.identities[1].aliases.push("Shadow Name".into());
        identity::write_vault(temp.path(), &vault).unwrap();
        let changed = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        assert_ne!(captured.digest, changed.digest);
        assert_eq!(
            reported_current(&dir, changed.digest),
            ("unavailable", None)
        );
    }

    #[test]
    fn a_persisted_pause_prevents_a_clean_disclosure_over_preserved_files() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("book.db");
        let id = seeded(&db, temp.path());
        let dir = temp.path().join("mirror");
        let first =
            mirror::pass_for_book(&db, &id, "book", "A Novel", &dir, 42, &Default::default())
                .unwrap();
        assert!(!first.paused);
        mirror::persist_pauses(
            &dir,
            &std::collections::HashSet::from([first.entries[0].id.clone()]),
        )
        .unwrap();
        let second =
            mirror::pass_for_book(&db, &id, "book", "A Novel", &dir, 43, &Default::default())
                .unwrap();
        assert!(second.paused);
        assert_eq!(first.entries, second.entries);
        let captured = capture(&db, &id, "A Novel", &dir, temp.path()).unwrap();
        record_after_pass(&dir, 43, Ok(&captured), &second).unwrap();
        assert_eq!(
            reported_current(&dir, captured.digest),
            ("unavailable", None)
        );
    }
}
