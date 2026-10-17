use super::*;
use sha2::{Digest, Sha256};

#[test]
fn legacy_fixture_exports_match_golden_bytes() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    for fixture in [
        "sample",
        "classics/alice",
        "classics/dracula",
        "classics/pride-and-prejudice",
    ] {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("book.db");
        store::seed::seed_project(&fixtures.join(fixture), &db).unwrap();
        let store = store::Store::open_readonly(&db).unwrap();
        let walk = walk_of(&store).unwrap();
        let book = crate::export::Book {
            publication: None,
            single_scene: walk.single_scene,
            name: fixture,
            contents_title: "Contents",
            front: &walk.front,
            chapters: &walk.chapters,
            back: &walk.back,
        };
        let design = crate::design::design_of(&store).unwrap();
        let style = crate::design::chapter_style_of(&store).unwrap();
        let markdown = crate::export::manuscript(&book, &walk.bodies).bytes;
        let docx = crate::docx::render(&book, &walk.bodies, "en").bytes;
        let epub = crate::epub::manuscript(&crate::epub::Epub {
            plan: None,
            notes_title: "Notes",
            book: &book,
            bodies: &walk.bodies,
            book_id: None,
            story_id: None,
            language: "en",
            font: &design.font,
            style,
            openings: walk.openings,
            cover: None,
            modified: "2026-10-17T00:00:00Z",
            pin: None,
        })
        .unwrap()
        .bytes;
        if let Some(out) = std::env::var_os("GARRET_EPUB_TEST_OUTPUT") {
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(
                PathBuf::from(out).join(format!("legacy-{}.epub", fixture.replace('/', "-"))),
                &epub,
            )
            .unwrap();
        }
        for (format, bytes) in [("markdown", markdown), ("docx", docx), ("epub", epub)] {
            let actual = format!("{fixture} {format} {:x}", Sha256::digest(&bytes));
            assert!(
                include_str!("legacy-exports.sha256")
                    .lines()
                    .any(|line| line == actual),
                "{actual}"
            );
        }
    }
}

#[test]
fn retained_legacy_epub_bodies_match_golden_bytes() {
    for (case, body) in [
        ("no-content", r#"{"type":"doc"}"#),
        ("empty", ""),
        (
            "hard-break",
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Before"},{"type":"hardBreak"},{"type":"text","text":"after"}]}]}"#,
        ),
        (
            "paragraph-attrs",
            r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"align":"center"},"content":[{"type":"text","text":"Retained prose"}]}]}"#,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("book.db");
        let store = store::Store::open(&db).unwrap();
        store
            .set_meta("book_id", "0199ed168c0070008000000000000001")
            .unwrap();
        let chapter = store.item_create(None, "chapter", "One").unwrap();
        let scene = store
            .item_create(Some(&chapter.id), "scene", "Scene")
            .unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE doc SET body=?1 WHERE item_id=?2",
            rusqlite::params![body, scene.id],
        )
        .unwrap();
        let dest = root.path().join("book.epub");
        export_as(
            &db,
            "Retained prose",
            &dest,
            crate::export::Format::Epub,
            &crate::identity::Vault::default(),
            crate::strings::Strings::english(),
        )
        .unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        let mut entries = crate::epub::read_zip(&bytes).unwrap();
        let (_, opf) = entries
            .iter_mut()
            .find(|(name, _)| name == crate::epub::OPF_PATH)
            .unwrap();
        let text = String::from_utf8(opf.clone()).unwrap();
        let start = text.find("<meta property=\"dcterms:modified\">").unwrap()
            + "<meta property=\"dcterms:modified\">".len();
        let end = start + text[start..].find("</meta>").unwrap();
        let mut text = text;
        text.replace_range(start..end, "2026-10-17T00:00:00Z");
        *opf = text.into_bytes();
        let normalized = crate::epub::zip(
            &entries
                .into_iter()
                .map(|(name, bytes)| crate::epub::Entry { name, bytes })
                .collect::<Vec<_>>(),
        );
        let actual = format!("{case} {:x}", Sha256::digest(&normalized));
        assert!(
            include_str!("legacy-retained-epub.sha256")
                .lines()
                .any(|line| line == actual),
            "{actual}"
        );
        if let Some(out) = std::env::var_os("GARRET_EPUB_TEST_OUTPUT") {
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(
                PathBuf::from(out).join(format!("retained-{case}.epub")),
                bytes,
            )
            .unwrap();
        }
    }
}
