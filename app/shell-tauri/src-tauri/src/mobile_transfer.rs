//! Private transfer preparation. Provider capabilities stay in the Android adapter.
use crate::{
    backup_bundle, encrypted_archive, mobile_core, store::Store, transfer_copy, transfer_publish,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) const ARCHIVE_LIMIT: u64 = 1 << 30;
pub(crate) const PAYLOAD_LIMIT: u64 = 512 << 20;
const RESERVE: u64 = 16 << 20;
const MAX_RETAINED: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Preview {
    pub title: Option<String>,
    pub related: Vec<String>,
    pub unreadable_books: usize,
    pub source: transfer_copy::Source,
    pub archive_bytes: u64,
    pub archive_sha256: String,
}

pub(crate) fn private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("transfer_storage".into()),
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "transfer_storage")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("transfer_storage".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != rustix::process::geteuid().as_raw() || meta.mode() & 0o077 != 0 {
            return Err("transfer_storage".into());
        }
    }
    Ok(())
}

fn stages(root: &Path) -> Result<Vec<PathBuf>, String> {
    private_dir(root)?;
    let mut found = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "transfer_storage")? {
        let entry = entry.map_err(|_| "transfer_storage")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if crate::mobile_core::is_canonical_uuid(name) {
            private_dir(&entry.path())?;
            found.push(entry.path());
        }
    }
    Ok(found)
}
pub(crate) fn retained(root: &Path) -> Result<usize, String> {
    Ok(stages(root)?.len())
}

pub(crate) const WRITE_MARKER: &str = "unverified-write";

pub(crate) fn write_started(stage: &Path) -> Result<(), String> {
    fs::write(
        stage.join(WRITE_MARKER),
        b"unverified provider destination\n",
    )
    .map_err(|_| "transfer_storage")?;
    fs::File::open(stage.join(WRITE_MARKER))
        .and_then(|file| file.sync_all())
        .map_err(|_| "transfer_storage")?;
    backup_bundle::sync_directory(stage).map_err(|_| "transfer_storage".into())
}
pub(crate) fn write_verified(stage: &Path) -> Result<(), String> {
    fs::remove_file(stage.join(WRITE_MARKER)).map_err(|_| "transfer_cleanup")?;
    backup_bundle::sync_directory(stage).map_err(|_| "transfer_cleanup".into())
}
pub(crate) fn finish_stage(stage: &Path, keep_uncertain: bool) -> Result<(), String> {
    if !stage.exists() {
        return Ok(());
    }
    if keep_uncertain && stage.join(WRITE_MARKER).is_file() {
        for entry in fs::read_dir(stage).map_err(|_| "transfer_cleanup")? {
            let entry = entry.map_err(|_| "transfer_cleanup")?;
            if entry.file_name() == "archive.out" || entry.file_name() == WRITE_MARKER {
                continue;
            }
            if entry.file_type().map_err(|_| "transfer_cleanup")?.is_dir() {
                fs::remove_dir_all(entry.path()).map_err(|_| "transfer_cleanup")?;
            } else {
                fs::remove_file(entry.path()).map_err(|_| "transfer_cleanup")?;
            }
        }
        backup_bundle::sync_directory(stage).map_err(|_| "transfer_cleanup")?;
    } else {
        fs::remove_dir_all(stage).map_err(|_| "transfer_cleanup")?;
    }
    Ok(())
}
pub(crate) fn sweep(root: &Path, discard: bool) -> Result<(), String> {
    for stage in stages(root)? {
        finish_stage(&stage, !discard)?;
    }
    for entry in fs::read_dir(root).map_err(|_| "transfer_cleanup")? {
        let entry = entry.map_err(|_| "transfer_cleanup")?;
        if entry.file_name().to_string_lossy().starts_with("probe-")
            && entry.file_type().map_err(|_| "transfer_cleanup")?.is_dir()
        {
            fs::remove_dir_all(entry.path()).map_err(|_| "transfer_cleanup")?;
        }
    }
    backup_bundle::sync_directory(root).map_err(|_| "transfer_cleanup".into())
}

pub(crate) fn stage(root: &Path, token: &str) -> Result<PathBuf, String> {
    if !crate::mobile_core::is_canonical_uuid(token) {
        return Err("transfer_stale".into());
    }
    if retained(root)? >= MAX_RETAINED {
        return Err("transfer_retained".into());
    }
    let path = root.join(token);
    if fs::symlink_metadata(&path).is_ok() {
        return Err("transfer_stale".into());
    }
    private_dir(&path)?;
    backup_bundle::sync_directory(root).map_err(|_| "transfer_storage")?;
    Ok(path)
}

pub(crate) fn available(path: &Path) -> Result<u64, String> {
    #[cfg(unix)]
    {
        let info = rustix::fs::statvfs(path).map_err(|_| "transfer_storage")?;
        info.f_bavail
            .checked_mul(info.f_frsize)
            .ok_or_else(|| "transfer_storage".into())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("transfer_storage".into())
    }
}

pub(crate) fn admit(free: u64, bytes: u64, copies: u64) -> Result<(), String> {
    if bytes > PAYLOAD_LIMIT {
        return Err("transfer_too_large".into());
    }
    let needed = bytes
        .checked_mul(copies)
        .and_then(|n| n.checked_add(RESERVE))
        .ok_or("transfer_too_large")?;
    if free < needed {
        return Err("transfer_storage".into());
    }
    Ok(())
}

pub(crate) fn read_budget(stage: &Path) -> Result<u64, String> {
    let budget = available(stage)?.saturating_sub(RESERVE) / 4;
    if budget < 1 << 20 {
        return Err("transfer_storage".into());
    }
    Ok(ARCHIVE_LIMIT.min(budget))
}

fn file_bytes(path: &Path) -> Result<u64, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "transfer_invalid")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("transfer_invalid".into());
    }
    Ok(meta.len())
}

fn tree_bytes(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(path).map_err(|_| "transfer_invalid")? {
        let path = entry.map_err(|_| "transfer_invalid")?.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| "transfer_invalid")?;
        if meta.file_type().is_symlink() {
            return Err("transfer_invalid".into());
        }
        let bytes = if meta.is_dir() {
            tree_bytes(&path)?
        } else {
            file_bytes(&path)?
        };
        total = total
            .checked_add(bytes)
            .filter(|n| *n <= PAYLOAD_LIMIT)
            .ok_or("transfer_too_large")?;
    }
    Ok(total)
}

pub(crate) fn fingerprint(path: &Path, limit: u64) -> Result<(u64, String), String> {
    let mut input =
        backup_bundle::open_regular_with_limit(path, limit).map_err(|_| "transfer_invalid")?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|_| "transfer_invalid")?;
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .filter(|n| *n <= limit)
            .ok_or("transfer_too_large")?;
        hash.update(&buffer[..n]);
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

pub(crate) fn snapshot(database: &Path, store: &Store, stage: &Path) -> Result<PathBuf, String> {
    mobile_core::supported(store)?;
    store.checkpoint().map_err(|_| "transfer_invalid")?;
    // Include every sidecar entry in admission, even originals the snapshot does not reference.
    let mut bytes = file_bytes(database)?
        .checked_mul(2)
        .ok_or("transfer_too_large")?;
    for assets in [
        crate::pictures::dir_for(database),
        crate::research::dir_for(database),
    ] {
        if assets.exists() {
            bytes = bytes
                .checked_add(tree_bytes(&assets)?)
                .ok_or("transfer_too_large")?;
        }
    }
    admit(available(stage)?, bytes, 4)?;
    let bundle = stage.join("snapshot.point");
    let written = backup_bundle::write(database, store, &bundle).map_err(|_| "transfer_invalid")?;
    if !written.verified {
        return Err("transfer_incomplete".into());
    }
    backup_bundle::verify(&bundle).map_err(|_| "transfer_incomplete")?;
    admit(available(stage)?, tree_bytes(&bundle)?, 3)?;
    Ok(bundle)
}

pub(crate) fn encrypt(
    bundle: &Path,
    stage: &Path,
    key_path: &Path,
) -> Result<(u64, String), String> {
    let key = encrypted_archive::key_from_path(key_path).map_err(|_| "transfer_key")?;
    let bytes = tree_bytes(bundle)?;
    admit(available(stage)?, bytes, 3)?;
    let cipher = stage.join("archive.out");
    encrypted_archive::write_verified_cipher(bundle, &cipher, &key)
        .map_err(|_| "transfer_invalid")?;
    fingerprint(&cipher, ARCHIVE_LIMIT)
}

pub(crate) fn probe<T>(
    path: &Path,
    read: impl FnOnce(&Store) -> Result<T, String>,
) -> Result<T, String> {
    let reader = Store::open_mobile_probe(path).map_err(|error| match error {
        crate::store::StoreError::NewerSchema { .. } => "unsupported_schema".to_string(),
        _ => "transfer_library_unreadable".to_string(),
    })?;
    mobile_core::supported(&reader)?;
    read(&reader)
}

pub(crate) fn preview(stage: &Path, books: &Path) -> Result<Preview, String> {
    let key =
        encrypted_archive::key_from_path(&stage.join("key.in")).map_err(|_| "transfer_key")?;
    let free = available(stage)?;
    let payload = PAYLOAD_LIMIT.min(free.saturating_sub(RESERVE) / 3);
    if payload < 1 << 20 {
        return Err("transfer_storage".into());
    }
    let bundle = encrypted_archive::extract_checked(
        &stage.join("archive.in"),
        &key,
        stage,
        ARCHIVE_LIMIT,
        payload,
        |bundle| mobile_core::open_supported(&backup_bundle::db_path(bundle)).map(|_| ()),
    )
    .map_err(|error| {
        if matches!(
            error.as_str(),
            "unsupported_schema" | "unsupported_project_preset"
        ) {
            error
        } else if error.contains("too large") {
            "transfer_too_large".into()
        } else {
            "transfer_invalid".into()
        }
    })?;
    let source = transfer_copy::inspect(&bundle).map_err(|error| transfer_error(error, "transfer_incomplete"))?;
    let mut related = Vec::new();
    let mut unreadable_books = 0;
    for entry in fs::read_dir(books).map_err(|_| "transfer_invalid")? {
        let entry = entry.map_err(|_| "transfer_invalid")?;
        if !entry.file_type().map_err(|_| "transfer_invalid")?.is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("db")
        {
            continue;
        }
        let related_name = probe(&entry.path(), |store| {
            if transfer_copy::lineage(store).map_err(|_| "transfer_library_unreadable")?
                == source.lineage
            {
                Ok(Some(
                    store
                        .get_meta(crate::core_constants::NAME_KEY)
                        .map_err(|_| "transfer_library_unreadable")?
                        .unwrap_or_default(),
                ))
            } else {
                Ok(None)
            }
        });
        match related_name {
            Ok(Some(name)) => related.push(name),
            Ok(None) => (),
            Err(_) => unreadable_books += 1,
        }
    }
    related.sort();
    admit(available(stage)?, tree_bytes(&bundle)?, 2)?;
    let (archive_bytes, archive_sha256) = fingerprint(&stage.join("archive.in"), ARCHIVE_LIMIT)?;
    Ok(Preview {
        title: source.title.clone(),
        related,
        unreadable_books,
        source,
        archive_bytes,
        archive_sha256,
    })
}

pub(crate) fn publish(stage: &Path, books: &Path, expected: &Preview) -> Result<String, String> {
    if fingerprint(&stage.join("archive.in"), ARCHIVE_LIMIT)?
        != (expected.archive_bytes, expected.archive_sha256.clone())
    {
        return Err("transfer_stale".into());
    }
    let bundle = stage.join("point");
    let reader = mobile_core::open_supported(&backup_bundle::db_path(&bundle))?;
    drop(reader);
    admit(available(stage)?, tree_bytes(&bundle)?, 2)?;
    let owned = transfer_copy::stage(&bundle, stage, &expected.source)
        .map_err(|error| {
            let fallback = if error.starts_with("transfer source changed") { "transfer_stale" } else { "transfer_invalid" };
            transfer_error(error, fallback)
        })?;
    let id = uuid::Uuid::now_v7().to_string();
    let dest = books.join(format!("{id}.db"));
    transfer_publish::publish(&owned.database, &dest).map_err(|_| "transfer_publish")?;
    Ok(id)
}

fn transfer_error(error: String, fallback: &str) -> String {
    if let Some((item_id, _)) = error.strip_prefix("document format refused: ").and_then(|message| message.split_once(':')) {
        format!("transfer_format:{item_id}")
    } else {
        fallback.into()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn contents(root: &Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
        let mut found = std::collections::BTreeMap::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.insert(path.strip_prefix(root).unwrap().to_path_buf(), None);
                for (child, data) in contents(&path) {
                    found.insert(path.strip_prefix(root).unwrap().join(child), data);
                }
            } else {
                found.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    Some(fs::read(path).unwrap()),
                );
            }
        }
        found
    }

    fn book(root: &Path) -> PathBuf {
        let path = root.join("original.db");
        let store = Store::open(&path).unwrap();
        store
            .set_meta(crate::core_constants::NAME_KEY, "Harbour")
            .unwrap();
        store
            .ensure_starter_structure(&crate::strings::Strings::new(&crate::strings::EN))
            .unwrap();
        let scene = store
            .items()
            .unwrap()
            .into_iter()
            .find(|item| item.item_type == "scene")
            .unwrap();
        let revision = store.load_doc(&scene.id).unwrap().rev;
        let entry = crate::store::FlushEntry {
            item_id: scene.id, base_rev: revision, comments: None,
            body: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The tide waited."}]}]}"#.into(),
        };
        store.flush(&[entry.clone()]).unwrap();
        store.record_versions(&[entry]).unwrap();
        let cast = store.cast_create("character", "Ada").unwrap();
        store.cast_set_picture(&cast.id, Some("face.png")).unwrap();
        fs::create_dir(crate::pictures::dir_for(&path)).unwrap();
        fs::write(
            crate::pictures::dir_for(&path).join("face.png"),
            include_bytes!("../fixtures/two-halves.png"),
        )
        .unwrap();
        let research = root.join("source.txt");
        fs::write(&research, b"A retained original").unwrap();
        crate::research::import_copy(&path, &research, |name, bytes, hash| {
            store.research_resource_add("Source", name, "text/plain", bytes, hash, "", "")
        })
        .unwrap();
        store.checkpoint().unwrap();
        path
    }
    fn incoming(root: &Path, db: &Path) -> PathBuf {
        let stage = stage(&root.join("transfer"), &uuid::Uuid::now_v7().to_string()).unwrap();
        let key = stage.join("key.in");
        encrypted_archive::generate_key(&key).unwrap();
        let store = Store::open_existing(db).unwrap();
        let bundle = snapshot(db, &store, &stage).unwrap();
        encrypt(&bundle, &stage, &key).unwrap();
        fs::copy(stage.join("archive.out"), stage.join("archive.in")).unwrap();
        stage
    }
    #[test]
    fn mobile_transfer_round_trip_keeps_both_books_and_all_originals() {
        let root = tempfile::tempdir().unwrap();
        let db = book(root.path());
        let stage = incoming(root.path(), &db);
        let books = root.path().join("books");
        fs::create_dir(&books).unwrap();
        fs::copy(&db, books.join("existing.db")).unwrap();
        let original = fs::read(&db).unwrap();
        let existing = fs::read(books.join("existing.db")).unwrap();
        fs::write(books.join("unreadable.db"), b"damaged book").unwrap();
        let review = preview(&stage, &books).unwrap();
        assert_eq!(review.related, ["Harbour"]);
        assert_eq!(review.unreadable_books, 1);
        assert_eq!(review.title.as_deref(), Some("Harbour"));
        let id = publish(&stage, &books, &review).unwrap();
        let copy = books.join(format!("{id}.db"));
        let copied = Store::open_readonly(&copy).unwrap();
        let source = Store::open_readonly(&db).unwrap();
        assert_ne!(copied.book_id().unwrap(), source.book_id().unwrap());
        assert_eq!(
            transfer_copy::lineage(&copied).unwrap(),
            source.book_id().unwrap().unwrap()
        );
        let scene = source
            .items()
            .unwrap()
            .into_iter()
            .find(|item| item.item_type == "scene")
            .unwrap();
        assert_eq!(
            copied.load_doc(&scene.id).unwrap().body,
            source.load_doc(&scene.id).unwrap().body
        );
        assert!(!copied.doc_versions(&scene.id).unwrap().is_empty());
        assert_eq!(
            fs::read(crate::pictures::dir_for(&copy).join("face.png")).unwrap(),
            include_bytes!("../fixtures/two-halves.png")
        );
        let resources: Vec<_> = fs::read_dir(crate::research::dir_for(&copy))
            .unwrap()
            .collect();
        assert_eq!(resources.len(), 1);
        assert_eq!(
            fs::read(resources[0].as_ref().unwrap().path()).unwrap(),
            b"A retained original"
        );
        assert_eq!(fs::read(&db).unwrap(), original);
        assert_eq!(fs::read(books.join("existing.db")).unwrap(), existing);
        assert!(stage.join("archive.in").exists());
        // Desktop restores the same archive produced by the phone's preparation core.
        let key = encrypted_archive::key_from_path(&stage.join("key.in")).unwrap();
        let desktop = root.path().join("desktop");
        let restored = encrypted_archive::restore(
            &stage.join("archive.out"),
            &key,
            &desktop,
            "book",
            1_700_000_000_000,
            root.path(),
        )
        .unwrap();
        assert_eq!(
            fs::read(crate::pictures::dir_for(Path::new(&restored.path)).join("face.png")).unwrap(),
            include_bytes!("../fixtures/two-halves.png")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(stage.join("archive.out"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn mobile_transfer_refuses_every_unsupported_raw_preset_before_writable_open() {
        let root = tempfile::tempdir().unwrap();
        let db = book(root.path());
        for preset in [
            None,
            Some("novel"),
            Some(""),
            Some("short"),
            Some("nonfiction"),
            Some("collection"),
            Some("Novel"),
            Some("zzz"),
        ] {
            let store = Store::open_existing(&db).unwrap();
            if let Some(value) = preset {
                store.set_meta("project.preset", value).unwrap();
            }
            store.checkpoint().unwrap();
            drop(store);
            let before = fs::read(&db).unwrap();
            let reader = Store::open_readonly(&db).unwrap();
            assert_eq!(
                mobile_core::supported(&reader).is_ok(),
                matches!(preset, None | Some("novel" | "short" | "nonfiction" | "collection")),
                "{preset:?}"
            );
            assert_eq!(fs::read(&db).unwrap(), before);
            if !matches!(preset, None | Some("novel" | "short" | "nonfiction" | "collection")) {
                let stage = stage(
                    &root.path().join("transfer"),
                    &uuid::Uuid::now_v7().to_string(),
                )
                .unwrap();
                // Make a desktop archive, which can contain layouts the phone refuses.
                let bundle = stage.join("snapshot.point");
                assert!(
                    backup_bundle::write(&db, &reader, &bundle)
                        .unwrap()
                        .verified
                );
                encrypted_archive::generate_key(&stage.join("key.in")).unwrap();
                let key = encrypted_archive::key_from_path(&stage.join("key.in")).unwrap();
                encrypted_archive::write_verified_cipher(&bundle, &stage.join("archive.in"), &key)
                    .unwrap();
                let books = root.path().join("books");
                fs::create_dir_all(&books).unwrap();
                assert_eq!(
                    preview(&stage, &books).unwrap_err(),
                    "unsupported_project_preset"
                );
                assert_eq!(fs::read_dir(&books).unwrap().count(), 0);
            }
        }
    }
    #[test]
    #[ignore = "explicit local phone fixture generation"]
    fn write_schema18_phone_fixture() {
        let out = PathBuf::from(std::env::var_os("GARRET_READER_FIXTURE_OUT").expect("fixture output required"));
        fs::create_dir(&out).expect("fixture output must not exist");
        let source = tempfile::tempdir_in(&out).unwrap();
        let db = source.path().join("source.db");
        let pixels: Vec<u8> = (0..160).flat_map(|_| (0..320).flat_map(|x| {
            if x < 160 { [220, 40, 40] } else { [40, 80, 220] }
        })).collect();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 320, 160);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
        }
        let (store, scene, body) = crate::store::test_support::reader_fixture_with_image(&db, &png);
        store.set_meta(crate::core_constants::NAME_KEY, "Schema 18 reader check").unwrap();
        store.set_meta(crate::core_constants::PRESET_KEY, "novel").unwrap();
        let bundle = source.path().join("snapshot.point");
        assert!(backup_bundle::write(&db, &store, &bundle).unwrap().verified);
        let key_path = out.join("reader-18-recovery-key.txt");
        encrypted_archive::generate_key(&key_path).unwrap();
        let key = encrypted_archive::key_from_path(&key_path).unwrap();
        let archive = out.join("reader-18.age");
        encrypted_archive::write_verified_cipher(&bundle, &archive, &key).unwrap();
        // Exercise the actual phone import path and retain its owned copy for adb seeding.
        let stage = stage(&source.path().join("transfer"), &uuid::Uuid::now_v7().to_string()).unwrap();
        fs::copy(&key_path, stage.join("key.in")).unwrap();
        fs::copy(&archive, stage.join("archive.in")).unwrap();
        let books = out.join("books");
        fs::create_dir(&books).unwrap();
        let preview = preview(&stage, &books).unwrap();
        let id = publish(&stage, &books, &preview).unwrap();
        let imported = Store::open_existing(&books.join(format!("{id}.db"))).unwrap();
        assert_eq!(imported.user_version().unwrap(), crate::store::document_format::READ_SCHEMA_VERSION);
        assert_eq!(imported.load_doc(&scene).unwrap().body, body);
        assert_eq!(imported.figure_assets().unwrap(), store.figure_assets().unwrap());
        imported.checkpoint().unwrap();
        drop(imported);
        fs::write(out.join("fixture.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "schema": crate::store::document_format::READ_SCHEMA_VERSION,
            "book_id": id, "scene_id": scene, "title": "Schema 18 reader check",
            "body": serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            "assets": store.figure_assets().unwrap()
        })).unwrap()).unwrap();
        fs::write(out.join("README.md"), "# Schema 18 reader phone check\n\nSynthetic sample only. Install the schema-18 reader APK first; 0.0.5 refuses this book.\n\n1. Copy reader-18.age and reader-18-recovery-key.txt to a phone-accessible folder.\n2. In garret's library, choose Import archive. Select the archive, then the recovery key. Review the preview and confirm.\n3. Open Schema 18 reader check and Reader fixture. Tap note 1: it contains Retained note and Second line. Close it.\n4. Check the split-color figure, Retained caption, its alternative text, the scene break, and After break.\n5. Edit only Surrounding prose or After break. Wait for Saved on this device. Close and reopen the app and book; confirm the edit, note, figure and break remain.\n6. Export the book and recovery key through Outline > Export book to test the reverse transfer.\n\nAtom insertion, deletion and editing are disabled in this reader release. Never decrement user_version.\nThe recovery key is synthetic test material; do not reuse it for real writing.\nbooks/ is a plaintext owned copy for isolated emulator seeding, not a phone import format. fixture.json describes expected content.\nRegenerate with scripts/android/reader-fixture OUTPUT_DIRECTORY (a new directory).\n").unwrap();
    }

    #[test]
    fn schema18_reader_mobile_archive_round_trip_preserves_nodes_and_originals() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("source.db");
        let (store, scene, body) = crate::store::test_support::reader_fixture(&db);
        let assets = store.figure_assets().unwrap();
        let stage = stage(&root.path().join("transfer"), &uuid::Uuid::now_v7().to_string()).unwrap();
        let bundle = stage.join("snapshot.point");
        assert!(backup_bundle::write(&db, &store, &bundle).unwrap().verified);
        encrypted_archive::generate_key(&stage.join("key.in")).unwrap();
        let key = encrypted_archive::key_from_path(&stage.join("key.in")).unwrap();
        encrypted_archive::write_verified_cipher(&bundle, &stage.join("archive.in"), &key).unwrap();
        let books = root.path().join("books");
        fs::create_dir(&books).unwrap();
        let preview = preview(&stage, &books).unwrap();
        let id = publish(&stage, &books, &preview).unwrap();
        let copied = Store::open_existing(&books.join(format!("{id}.db"))).unwrap();
        assert_eq!(copied.user_version().unwrap(), 18);
        assert_eq!(copied.load_doc(&scene).unwrap().body, body);
        assert_eq!(copied.figure_assets().unwrap(), assets);
        copied.validate_retained_formats().unwrap();
    }

    #[test]
    fn mobile_transfer_schema_refusal_precedes_preset_and_never_publishes() {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Asset {
            name: String,
            bytes: u64,
            hash: String,
        }
        #[derive(serde::Serialize, serde::Deserialize)]
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
        for (preset, newer, code) in [
            ("zzz", false, "unsupported_project_preset"),
            ("novel", true, "unsupported_schema"),
            ("short", true, "unsupported_schema"),
            ("nonfiction", true, "unsupported_schema"),
            ("collection", true, "unsupported_schema"),
            ("zzz", true, "unsupported_schema"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let db = book(root.path());
            let store = Store::open_existing(&db).unwrap();
            store.set_meta("project.preset", preset).unwrap();
            let stage = stage(
                &root.path().join("transfer"),
                &uuid::Uuid::now_v7().to_string(),
            )
            .unwrap();
            let bundle = stage.join("snapshot.point");
            assert!(backup_bundle::write(&db, &store, &bundle).unwrap().verified);
            drop(store);
            if newer {
                let connection =
                    rusqlite::Connection::open(backup_bundle::db_path(&bundle)).unwrap();
                connection
                    .pragma_update(None, "user_version", crate::store::READ_SCHEMA_VERSION + 1)
                    .unwrap();
                drop(connection);
                let inventory_path = bundle.join(backup_bundle::INVENTORY_NAME);
                let mut inventory: Inventory =
                    serde_json::from_slice(&fs::read(&inventory_path).unwrap()).unwrap();
                inventory.db_hash = format!(
                    "{:016x}",
                    crate::store::history::hash64(
                        &fs::read(backup_bundle::db_path(&bundle)).unwrap()
                    )
                );
                inventory.checksum.clear();
                inventory.checksum = format!(
                    "{:016x}",
                    crate::store::history::hash64(&serde_json::to_vec(&inventory).unwrap())
                );
                fs::write(inventory_path, serde_json::to_vec(&inventory).unwrap()).unwrap();
            }
            encrypted_archive::generate_key(&stage.join("key.in")).unwrap();
            let key = encrypted_archive::key_from_path(&stage.join("key.in")).unwrap();
            let output = fs::File::create(stage.join("archive.in")).unwrap();
            let writer = age::Encryptor::with_recipients(std::iter::once(
                &key.to_public() as &dyn age::Recipient
            ))
            .unwrap()
            .wrap_output(output)
            .unwrap();
            let mut tar = tar::Builder::new(writer);
            tar.append_path_with_name(
                bundle.join(backup_bundle::INVENTORY_NAME),
                backup_bundle::INVENTORY_NAME,
            )
            .unwrap();
            tar.append_path_with_name(backup_bundle::db_path(&bundle), backup_bundle::DB_NAME)
                .unwrap();
            for directory in [backup_bundle::PICTURES_NAME, backup_bundle::RESEARCH_NAME] {
                let dir = bundle.join(directory);
                tar.append_dir(format!("{directory}/"), &dir).unwrap();
                let mut files: Vec<_> = fs::read_dir(&dir)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect();
                files.sort();
                for file in files {
                    tar.append_path_with_name(
                        &file,
                        Path::new(directory).join(file.file_name().unwrap()),
                    )
                    .unwrap();
                }
            }
            tar.into_inner()
                .unwrap()
                .finish()
                .unwrap()
                .sync_all()
                .unwrap();
            let books = root.path().join("books");
            fs::create_dir(&books).unwrap();
            book(&books);
            let before = contents(&books);
            assert_eq!(
                preview(&stage, &books).unwrap_err(),
                code,
                "{preset} {newer}"
            );
            assert_eq!(contents(&books), before, "{preset} {newer}");
            assert!(!stage.join("owned-copy").exists());
        }
    }
    #[test]
    fn mobile_transfer_refuses_stale_preview_and_truncated_archive_without_publication() {
        let root = tempfile::tempdir().unwrap();
        let db = book(root.path());
        let stage = incoming(root.path(), &db);
        let books = root.path().join("books");
        fs::create_dir(&books).unwrap();
        let review = preview(&stage, &books).unwrap();
        let archive = stage.join("archive.in");
        let bytes = fs::read(&archive).unwrap();
        fs::write(&archive, &bytes[..bytes.len() - 1]).unwrap();
        assert!(publish(&stage, &books, &review).is_err());
        assert_eq!(fs::read_dir(&books).unwrap().count(), 0);
        assert!(!stage.join("owned-copy").exists());
        let partial = stage
            .parent()
            .unwrap()
            .join(uuid::Uuid::now_v7().to_string());
        private_dir(&partial).unwrap();
        fs::copy(&archive, partial.join("archive.in")).unwrap();
        fs::copy(stage.join("key.in"), partial.join("key.in")).unwrap();
        assert!(preview(&partial, &books).is_err());
        assert!(archive.exists());
        assert!(db.exists());

        // A tiny encrypted input can declare an oversized plaintext member.
        let oversized = stage
            .parent()
            .unwrap()
            .join(uuid::Uuid::now_v7().to_string());
        private_dir(&oversized).unwrap();
        fs::copy(stage.join("key.in"), oversized.join("key.in")).unwrap();
        let key = encrypted_archive::key_from_path(&oversized.join("key.in")).unwrap();
        let inventory = br#"{"version":1,"expected":[],"assets":[]}"#;
        let mut plain = Vec::new();
        for (name, size, body) in [
            (
                "inventory.json",
                inventory.len() as u64,
                inventory.as_slice(),
            ),
            ("project.db", PAYLOAD_LIMIT + 1, &[][..]),
        ] {
            let mut header = tar::Header::new_ustar();
            header.set_path(name).unwrap();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(size);
            header.set_cksum();
            plain.extend_from_slice(header.as_bytes());
            plain.extend_from_slice(body);
            plain.resize(plain.len().div_ceil(512) * 512, 0);
        }
        use std::io::Write;
        let mut encrypted = age::Encryptor::with_recipients(std::iter::once(
            &key.to_public() as &dyn age::Recipient
        ))
        .unwrap()
        .wrap_output(Vec::new())
        .unwrap();
        encrypted.write_all(&plain).unwrap();
        fs::write(oversized.join("archive.in"), encrypted.finish().unwrap()).unwrap();
        assert_eq!(
            preview(&oversized, &books).unwrap_err(),
            "transfer_too_large"
        );
        assert!(!oversized.join("point/project.db").exists());
    }
    #[test]
    fn mobile_transfer_storage_and_restart_boundaries_preserve_uncertain_stages() {
        assert_eq!(admit(RESERVE + 99, 50, 2).unwrap_err(), "transfer_storage");
        assert!(admit(RESERVE + 100, 50, 2).is_ok());
        assert_eq!(
            admit(u64::MAX, PAYLOAD_LIMIT + 1, 1).unwrap_err(),
            "transfer_too_large"
        );
        assert!(admit(u64::MAX, u64::MAX, 4).is_err());
        let root = tempfile::tempdir().unwrap();
        let transfer_root = root.path().join("transfer");
        let token = uuid::Uuid::now_v7().to_string();
        let first = stage(&transfer_root, &token).unwrap();
        fs::write(
            first.join("archive.out"),
            b"retained verified or partial output",
        )
        .unwrap();
        assert_eq!(retained(&transfer_root).unwrap(), 1);
        assert!(stage(&transfer_root, &token).is_err());
        let second = stage(&transfer_root, &uuid::Uuid::now_v7().to_string()).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            fs::read(first.join("archive.out")).unwrap(),
            b"retained verified or partial output"
        );
        assert!(stage(&transfer_root, "../book").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let unsafe_root = root.path().join("unsafe");
            symlink(&transfer_root, &unsafe_root).unwrap();
            assert!(retained(&unsafe_root).is_err());
            fs::set_permissions(&transfer_root, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(retained(&transfer_root).is_err());
        }
    }
}
