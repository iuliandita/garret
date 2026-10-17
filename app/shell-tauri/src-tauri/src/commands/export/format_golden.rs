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
        let plan = crate::publication_plan::Plan::from_store(
            &book,
            &walk.bodies,
            walk.note_scopes,
            &store,
            &db,
        )
        .unwrap();
        let epub = crate::epub::manuscript(&crate::epub::Epub {
            plan: Some(&plan),
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
