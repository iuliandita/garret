use super::*;
use crate::publication_plan::{Asset, Plan};
use serde_json::json;
use std::collections::HashMap;

struct Fixture {
    root: tempfile::TempDir,
    db: PathBuf,
    store: store::Store,
    stories: Vec<String>,
    scenes: Vec<String>,
    assets: Vec<store::figure_assets::FigureAsset>,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    store.set_meta("project.preset", "collection").unwrap();
    store::figure_assets::test_support::install(&store);
    let mut stories = Vec::new();
    let mut scenes = Vec::new();
    let mut assets = Vec::new();
    let source = root.path().join("picked.png");
    std::fs::write(&source, crate::figures::tests::PNG).unwrap();
    for index in 0..2 {
        if index == 1 {
            std::fs::write(&source, include_bytes!("../../../fixtures/two-halves.jpg")).unwrap();
        }
        let story = store
            .item_create(None, "chapter", &format!("Story {index}"))
            .unwrap();
        let chapter = store
            .item_create(Some(&story.id), "chapter", "Section")
            .unwrap();
        let scene = store
            .item_create(Some(&chapter.id), "scene", "Scene")
            .unwrap();
        let asset = crate::figures::test_support::import(&db, &store, &source);
        let body = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"A literal [^1] & 😀"},
                {"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000001","fmt":"text","body":format!("note {index}\nsecond <line>")}},
                {"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000003","fmt":"text","body":format!("additional {index}")}}]},
            {"type":"figure","attrs":{"id":"0199ed16-8c00-7000-8000-000000000002","asset_id":asset.id,"width":if index == 0 {"page"} else {"half"},"caption":format!("caption {index} & <text>"),"alt":"A \"quoted\" <view> & sky"}},
            {"type":"scene_break"}
        ]}).to_string();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE doc SET body=?1 WHERE item_id=?2",
            rusqlite::params![body, scene.id],
        )
        .unwrap();
        if index == 0 {
            let second = store
                .item_create(Some(&story.id), "chapter", "Second section")
                .unwrap();
            let later = store
                .item_create(Some(&second.id), "scene", "Later")
                .unwrap();
            conn.execute(
                "UPDATE doc SET body=?1 WHERE item_id=?2",
                rusqlite::params![body, later.id],
            )
            .unwrap();
            let retained = store
                .item_create(Some(&second.id), "scene", "Retained")
                .unwrap();
            conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![
                r#"{"type":"doc","content":[{"type":"paragraph","attrs":{},"content":[{"type":"text","text":"Mixed legacy prose"}]}]}"#, retained.id]).unwrap();
        }
        stories.push(story.id);
        scenes.push(scene.id);
        assets.push(asset);
    }
    Fixture {
        root,
        db,
        store,
        stories,
        scenes,
        assets,
    }
}

fn with_plan<T>(
    fixture: &Fixture,
    story: Option<&str>,
    f: impl FnOnce(&crate::export::Book, &Walked, &Plan) -> T,
) -> T {
    let walk = walk_scope(&fixture.store, story).unwrap();
    let book = crate::export::Book {
        publication: None,
        single_scene: walk.single_scene,
        name: "Collected",
        contents_title: "Contents",
        front: &walk.front,
        chapters: &walk.chapters,
        back: &walk.back,
    };
    let scopes = publication_scopes(&fixture.store).unwrap();
    let plan = Plan::from_store(&book, &walk.bodies, scopes, &fixture.store, &fixture.db).unwrap();
    f(&book, &walk, &plan)
}

fn epub(book: &crate::export::Book, walk: &Walked, plan: &Plan) -> Vec<u8> {
    crate::epub::manuscript(&crate::epub::Epub {
        book,
        bodies: &walk.bodies,
        plan: Some(plan),
        notes_title: "Notes",
        book_id: None,
        story_id: None,
        language: "en",
        font: "serif",
        style: Default::default(),
        openings: Default::default(),
        cover: None,
        modified: "2026-10-17T00:00:00Z",
        pin: None,
    })
    .unwrap()
    .bytes
}

#[test]
fn docx_publication_uses_native_notes_scopes_and_inline_media() {
    for (numbering, selected, sections, expected_numbers) in [
        ("book", false, 1, vec![1, 2, 3, 4, 5, 6]),
        ("story", false, 2, vec![1, 2, 3, 4, 1, 2]),
        ("chapter", false, 5, vec![1, 2, 1, 2, 1, 2]),
        ("story", true, 1, vec![1, 2, 3, 4]),
    ] {
        let fixture = fixture();
        fixture.store.set_meta("notes.numbering", numbering).unwrap();
        with_plan(&fixture, selected.then_some(fixture.stories[0].as_str()), |_book, _walk, plan| {
            assert_eq!(plan.notes.iter().map(|note| note.number).collect::<Vec<_>>(), expected_numbers);
            let bytes = render_scope_policy(&fixture.db, "Collected", crate::export::Format::Docx,
                &crate::identity::Vault::default(), crate::strings::Strings::english(), None,
                selected.then_some(fixture.stories[0].as_str()), true).unwrap().0.bytes;
            let entries = crate::epub::read_zip(&bytes).unwrap();
            let part = |name: &str| String::from_utf8(entries.iter().find(|(path, _)| path == name).unwrap().1.clone()).unwrap();
            for (path, bytes) in &entries {
                if path.ends_with(".xml") || path.ends_with(".rels") {
                    let mut reader = quick_xml::Reader::from_reader(bytes.as_slice());
                    loop { match reader.read_event().unwrap() { quick_xml::events::Event::Eof => break, _ => {} } }
                }
            }
            let document = part("word/document.xml");
            let notes = part("word/endnotes.xml");
            assert_eq!(document.matches("<w:endnoteReference ").count(), plan.notes.len());
            assert_eq!(notes.matches("<w:endnote w:id=").count(), plan.notes.len());
            let custom = plan.notes.iter().enumerate().any(|(index, note)| note.number != index + 1);
            assert_eq!(document.matches("w:customMarkFollows=\"1\"").count(), if custom { plan.notes.len() } else { 0 });
            for index in 1..=plan.notes.len() {
                assert!(document.contains(&format!("<w:endnoteReference w:id=\"{index}\"")));
                assert!(notes.contains(&format!("<w:endnote w:id=\"{index}\">")));
                if custom {
                    assert!(document.contains(&format!("w:id=\"{index}\" w:customMarkFollows=\"1\"/><w:t>{}</w:t>", plan.notes[index - 1].number)));
                }
            }
            assert!(notes.contains("w:type=\"separator\" w:id=\"-1\""));
            assert!(notes.contains("w:type=\"continuationSeparator\" w:id=\"0\""));
            assert!(notes.contains("second &lt;line&gt;"));
            assert_eq!(document.matches("<w:numRestart w:val=\"eachSect\"/>").count(), sections);
            assert_eq!(document.matches("<w:pos w:val=\"sectEnd\"/>").count(), sections);
            assert!(document.contains("Mixed legacy prose"));
            assert!(document.contains("descr=\"A &quot;quoted&quot; &lt;view&gt; &amp; sky\""));
            assert!(document.contains("caption 0 &amp; &lt;text&gt;"));
            assert!(document.contains("<w:t>* * *</w:t>"));
            assert_eq!(document.matches("<wp:inline ").count(), if selected { 2 } else { 3 });
            assert!(!document.contains("wp:anchor"));
            let rels = part("word/_rels/document.xml.rels");
            let types = part("[Content_Types].xml");
            assert!(rels.contains("/endnotes\" Target=\"endnotes.xml\""));
            assert!(types.contains("wordprocessingml.endnotes+xml"));
            assert!(rels.contains("/settings\" Target=\"settings.xml\""));
            assert!(types.contains("PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\""));
            let settings = part("word/settings.xml");
            assert!(settings.contains("<w:endnotePr><w:endnote w:id=\"-1\"/><w:endnote w:id=\"0\"/></w:endnotePr>"));
            for (index, asset) in plan.assets.values().enumerate() {
                let name = asset.href.strip_prefix("assets/").unwrap();
                assert!(rels.contains(&format!("Target=\"media/{name}\"")));
                assert!(document.contains(&format!("r:embed=\"rId{}\"", index + 2)));
                assert!(types.contains(&format!("ContentType=\"{}\"", asset.mime)));
                assert_eq!(entries.iter().find(|(path, _)| path == &format!("word/media/{name}")).unwrap().1, asset.bytes);
            }
            assert_eq!(plan.assets.len(), if selected { 1 } else { 2 });
            if selected { assert!(!notes.contains("note 1")); }
            if let Some(out) = std::env::var_os("GARRET_DOCX_TEST_OUTPUT") {
                std::fs::create_dir_all(&out).unwrap();
                std::fs::write(PathBuf::from(out).join(format!("{numbering}-{selected}.docx")), bytes).unwrap();
            }
        });
    }
}

#[test]
fn docx_non_contiguous_note_scope_resumes_its_planned_start() {
    let chapters: Vec<_> = ["a", "b", "c"].into_iter().map(|id| (id.to_string(), id.to_uppercase(), 0)).collect();
    let book = crate::export::Book { publication: None, single_scene: false, name: "Notes", contents_title: "Contents", front: &[], chapters: &chapters, back: &[] };
    let bodies = HashMap::from_iter(chapters.iter().map(|(id, _, _)| (id.clone(), json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"Prose"},
        {"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000001","fmt":"text","body":"A note"}}
    ]}]}).to_string())));
    let scopes = crate::publication_plan::Scopes {
        by_item: HashMap::from([("a".into(), 0), ("b".into(), 1), ("c".into(), 0)]),
        rows: vec![crate::publication_plan::Scope { label: "Outer".into(), end: "c".into() }, crate::publication_plan::Scope { label: "Inner".into(), end: "b".into() }],
    };
    let plan = crate::publication_plan::Plan::build(&book, &bodies, scopes, |_| unreachable!()).unwrap();
    assert_eq!(plan.notes.iter().map(|note| note.number).collect::<Vec<_>>(), [1, 1, 2]);
    let rendered = crate::docx::render_planned(&book, &bodies, "en", Some(&plan)).unwrap();
    let entries = crate::epub::read_zip(&rendered.bytes).unwrap();
    let document = String::from_utf8_lossy(&entries.iter().find(|(name, _)| name == "word/document.xml").unwrap().1);
    let starts: Vec<_> = document.split("<w:numStart w:val=\"").skip(1).map(|tail| tail.split('"').next().unwrap()).collect();
    assert_eq!(starts, ["1", "1", "2"]);
    if let Some(out) = std::env::var_os("GARRET_DOCX_TEST_OUTPUT") {
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(PathBuf::from(out).join("non-contiguous.docx"), rendered.bytes).unwrap();
    }
}

#[test]
fn docx_distinct_asset_ids_with_identical_originals_share_a_media_part() {
    let fixture = fixture();
    let alias = crate::figures::test_support::import(&fixture.db, &fixture.store, &fixture.root.path().join("picked.png"));
    let mut body: serde_json::Value = serde_json::from_str(&fixture.store.load_doc(&fixture.scenes[1]).unwrap().body).unwrap();
    let mut duplicate = body["content"][1].clone();
    duplicate["attrs"]["id"] = json!("0199ed16-8c00-7000-8000-000000000099");
    duplicate["attrs"]["asset_id"] = json!(alias.id);
    body["content"].as_array_mut().unwrap().push(duplicate);
    let conn = rusqlite::Connection::open(&fixture.db).unwrap();
    conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![body.to_string(), fixture.scenes[1]]).unwrap();
    with_plan(&fixture, None, |book, walk, plan| {
        assert_eq!(plan.assets.len(), 3);
        let rendered = crate::docx::render_planned(book, &walk.bodies, "en", Some(plan)).unwrap();
        let entries = crate::epub::read_zip(&rendered.bytes).unwrap();
        let media: Vec<_> = entries.iter().filter(|(name, _)| name.starts_with("word/media/")).collect();
        assert_eq!(media.len(), 2);
        let types = String::from_utf8_lossy(&entries.iter().find(|(name, _)| name == "[Content_Types].xml").unwrap().1);
        assert_eq!(types.matches("Extension=\"jpg\"").count(), 1);
        assert_eq!(types.matches("Extension=\"png\"").count(), 1);
        let document = String::from_utf8_lossy(&entries.iter().find(|(name, _)| name == "word/document.xml").unwrap().1);
        assert_eq!(document.matches("<wp:inline ").count(), 4);
        for id in 1..=4 { assert_eq!(document.matches(&format!("<wp:docPr id=\"{id}\"")).count(), 1); }
    });
}

fn check_links(entries: &[(String, Vec<u8>)]) {
    use quick_xml::{events::Event, Reader};
    let mut ids = HashMap::new();
    let mut links = Vec::new();
    let mut positions = HashMap::new();
    for (path, bytes) in entries.iter().filter(|(path, _)| path.ends_with(".xhtml")) {
        let mut reader = Reader::from_reader(bytes.as_slice());
        let mut local = std::collections::HashSet::new();
        loop {
            match reader.read_event().unwrap() {
                Event::Start(element) | Event::Empty(element) => {
                    for attr in element.attributes() {
                        let attr = attr.unwrap();
                        let value = attr
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .unwrap()
                            .into_owned();
                        match attr.key.as_ref() {
                            b"id" => {
                                positions.insert((path.clone(), value.clone()), local.len());
                                assert!(local.insert(value), "duplicate ID in {path}");
                            }
                            b"href" | b"src" => links.push((path.clone(), value)),
                            _ => {}
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        ids.insert(path.clone(), local);
    }
    let spine = crate::epub::reading_order(entries);
    let mut previous = None;
    for (from, link) in links {
        assert!(
            !link.starts_with('/') && !link.contains(":"),
            "nonrelative link {link}"
        );
        let (file, fragment) = link
            .split_once('#')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((&link, None));
        let target = Path::new(&from).parent().unwrap().join(file);
        let mut normalized = PathBuf::new();
        for component in target.components() {
            if component == std::path::Component::ParentDir {
                normalized.pop();
            } else {
                normalized.push(component);
            }
        }
        let target = normalized.to_str().unwrap();
        assert!(
            entries.iter().any(|(path, _)| path == target),
            "missing {link} from {from}"
        );
        if let Some(fragment) = fragment {
            assert!(ids[target].contains(fragment), "missing fragment {link}");
        }
        if from.ends_with("/nav.xhtml") && !link.ends_with(".css") {
            let doc = spine.iter().position(|(path, _)| path == target).unwrap();
            let position = fragment
                .map(|fragment| positions[&(target.to_string(), fragment.to_string())] + 1)
                .unwrap_or(0);
            let current = (doc, position);
            assert!(
                previous.is_none_or(|previous| previous <= current),
                "navigation moves backwards at {link}"
            );
            previous = Some(current);
        }
    }
}

#[test]
fn scoped_epub_notes_media_and_fallback_links_resolve() {
    let fixture = fixture();
    for numbering in ["book", "chapter", "story"] {
        fixture
            .store
            .set_meta("notes.numbering", numbering)
            .unwrap();
        for selected in [false, true] {
            with_plan(
                &fixture,
                selected.then_some(fixture.stories[0].as_str()),
                |book, walk, plan| {
                    assert_eq!(plan.notes.len(), if selected { 4 } else { 6 });
                    assert_eq!(plan.assets.len(), if selected { 1 } else { 2 });
                    assert_eq!(
                        plan.notes
                            .iter()
                            .map(|note| note.number)
                            .collect::<Vec<_>>(),
                        match (numbering, selected) {
                            ("chapter", true) => vec![1, 2, 1, 2],
                            ("chapter", false) => vec![1, 2, 1, 2, 1, 2],
                            (_, true) => vec![1, 2, 3, 4],
                            ("book", false) => vec![1, 2, 3, 4, 5, 6],
                            _ => vec![1, 2, 3, 4, 1, 2],
                        }
                    );
                    let bytes = epub(book, walk, plan);
                    let entries = crate::epub::read_zip(&bytes).unwrap();
                    check_links(&entries);
                    let media = entries
                        .iter()
                        .filter(|(name, _)| name.starts_with("OEBPS/assets/"))
                        .collect::<Vec<_>>();
                    assert_eq!(media.len(), if selected { 1 } else { 2 });
                    if selected {
                        assert!(media
                            .iter()
                            .all(|(name, _)| !name.contains(&fixture.assets[1].sha256)));
                    }
                    for (index, note) in plan.notes.iter().enumerate() {
                        let reference = entries
                            .iter()
                            .find(|(_, data)| {
                                String::from_utf8_lossy(data)
                                    .contains(&format!("id=\"ref-{}\"", index + 1))
                            })
                            .unwrap();
                        let target = entries
                            .iter()
                            .find(|(_, data)| {
                                String::from_utf8_lossy(data)
                                    .contains(&format!("id=\"note-{}\"", index + 1))
                            })
                            .unwrap();
                        let reference_text = String::from_utf8_lossy(&reference.1);
                        let target_text = String::from_utf8_lossy(&target.1);
                        let reference_name = Path::new(&reference.0)
                            .file_name()
                            .unwrap()
                            .to_str()
                            .unwrap();
                        let target_name =
                            Path::new(&target.0).file_name().unwrap().to_str().unwrap();
                        assert!(reference_text.contains(&format!(
                            "href=\"{target_name}#note-{}\">{}<",
                            index + 1,
                            note.number
                        )));
                        assert!(target_text.contains(&format!(
                            "href=\"{reference_name}#ref-{}\">{}<",
                            index + 1,
                            note.number
                        )));
                    }
                    let text = entries
                        .iter()
                        .filter(|(name, _)| name.ends_with(".xhtml"))
                        .map(|(_, bytes)| String::from_utf8_lossy(bytes))
                        .collect::<Vec<_>>()
                        .join("\n");
                    for expected in [
                        "epub:type=\"noteref\"",
                        "epub:type=\"endnote\"",
                        "epub:type=\"backlink\"",
                        "<figcaption>caption 0 &amp; &lt;text&gt;</figcaption>",
                        "alt=\"A &quot;quoted&quot; &lt;view&gt; &amp; sky\"",
                        "<hr class=\"scene-break\"/>",
                        "literal [^1]",
                        "second &lt;line&gt;",
                        "class=\"page\"",
                        "Mixed legacy prose",
                    ] {
                        assert!(text.contains(expected), "{expected}");
                    }
                    if selected {
                        for excluded in ["note 1", "caption 1", "Story 1"] {
                            assert!(!text.contains(excluded), "{excluded}");
                        }
                    }
                    let opf = entries
                        .iter()
                        .find(|(name, _)| name.ends_with("content.opf"))
                        .unwrap();
                    assert!(String::from_utf8_lossy(&opf.1).contains("media-type=\"image/png\""));
                    assert_eq!(
                        String::from_utf8_lossy(&opf.1).contains("media-type=\"image/jpeg\""),
                        !selected
                    );
                    let css = &entries
                        .iter()
                        .find(|(name, _)| name.ends_with("style.css"))
                        .unwrap()
                        .1;
                    assert!(String::from_utf8_lossy(css).contains("break-before: page"));
                    if let Some(out) = std::env::var_os("GARRET_EPUB_TEST_OUTPUT") {
                        std::fs::create_dir_all(&out).unwrap();
                        std::fs::write(
                            PathBuf::from(out).join(format!("{numbering}-{selected}.epub")),
                            bytes,
                        )
                        .unwrap();
                    }
                },
            );
        }
    }
    // Missing unselected originals cannot block or leak into a selected-story export.
    std::fs::remove_file(
        crate::pictures::dir_for(&fixture.db).join(&fixture.assets[1].stored_name),
    )
    .unwrap();
    with_plan(&fixture, Some(&fixture.stories[0]), |book, walk, plan| {
        check_links(&crate::epub::read_zip(&epub(book, walk, plan)).unwrap());
    });
}

#[test]
fn publication_refusals_preserve_unknown_content_and_missing_originals() {
    let fixture = fixture();
    fixture.store.set_meta("notes.numbering", "future").unwrap();
    assert!(publication_scopes(&fixture.store)
        .err()
        .unwrap()
        .contains("unsupported note numbering"));
    fixture.store.delete_meta("notes.numbering").unwrap();
    let walk = walk_scope(&fixture.store, Some(&fixture.stories[0])).unwrap();
    let book = crate::export::Book {
        publication: None,
        single_scene: false,
        name: "N",
        contents_title: "Contents",
        front: &walk.front,
        chapters: &walk.chapters,
        back: &walk.back,
    };
    let build = |bodies: &HashMap<String, String>| {
        Plan::from_store(
            &book,
            bodies,
            crate::publication_plan::Scopes::book(&book),
            &fixture.store,
            &fixture.db,
        )
    };
    assert!(build(&walk.bodies).is_ok());
    let original: serde_json::Value =
        serde_json::from_str(&walk.bodies[&fixture.scenes[0]]).unwrap();
    for (pointer, value) in [
        ("/content/0/content/1/attrs/fmt", json!("html")),
        (
            "/content/1/attrs/asset_id",
            json!("0199ed16-8c00-7000-8000-000000000099"),
        ),
        ("/content/1/attrs/alt", json!("  ")),
        ("/content/2/type", json!("future")),
    ] {
        let mut value_body = original.clone();
        *value_body.pointer_mut(pointer).unwrap() = value;
        let mut bodies = walk.bodies.clone();
        bodies.insert(fixture.scenes[0].clone(), value_body.to_string());
        assert!(build(&bodies).is_err(), "accepted {pointer}");
    }
    let note_only = HashMap::from([(
        fixture.scenes[0].clone(),
        json!({"type":"doc","content":[original["content"][0].clone()]}).to_string(),
    )]);
    assert!(
        Plan::build(&book, &note_only, Default::default(), |_| panic!(
            "no figure in this body"
        ))
        .err()
        .unwrap()
        .contains("missing note scope")
    );
    let path = crate::pictures::dir_for(&fixture.db).join(&fixture.assets[0].stored_name);
    let original_bytes = std::fs::read(&path).unwrap();
    let mut corrupt = original_bytes.clone();
    corrupt[20] ^= 1;
    std::fs::write(&path, corrupt).unwrap();
    assert!(build(&walk.bodies)
        .err()
        .unwrap()
        .contains("hash or size mismatch"));
    std::fs::remove_file(&path).unwrap();
    assert!(build(&walk.bodies).is_err());
    std::fs::write(&path, &original_bytes).unwrap();
    assert!(build(&walk.bodies).is_ok());
    let mut record = fixture.assets[0].clone();
    record.bytes += 1;
    assert!(Asset::verified(&record, original_bytes.clone()).is_err());
    record = fixture.assets[0].clone();
    record.mime = "image/jpeg".into();
    assert!(Asset::verified(&record, original_bytes.clone()).is_err());
    record = fixture.assets[0].clone();
    record.width_px += 1;
    assert!(Asset::verified(&record, original_bytes).is_err());
    #[cfg(unix)]
    {
        let dir = crate::pictures::dir_for(&fixture.db);
        let moved = fixture.root.path().join("retained-originals");
        std::fs::rename(&dir, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &dir).unwrap();
        assert!(build(&walk.bodies)
            .err()
            .unwrap()
            .contains("unsafe or missing original directory"));
        std::fs::remove_file(&dir).unwrap();
        std::fs::rename(&moved, &dir).unwrap();
        assert!(build(&walk.bodies).is_ok());
    }
    assert_eq!(fixture.store.user_version().unwrap(), 17);
    assert!(!store::document_format::new_nodes_allowed());
    assert!(fixture.root.path().exists());
}

#[test]
fn disabled_new_node_epub_refuses_before_publishing_a_destination() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    let scene = store.item_create(None, "scene", "Scene").unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("UPDATE doc SET body=?1 WHERE item_id=?2", rusqlite::params![r#"{"type":"doc","content":[{"type":"scene_break"},{"type":"future","content":[{"type":"text","text":"Hidden prose"}]}]}"#, scene.id]).unwrap();
    let dest = root.path().join("book.epub");
    let error = export_as(
        &db,
        "Book",
        &dest,
        crate::export::Format::Epub,
        &crate::identity::Vault::default(),
        crate::strings::Strings::english(),
    )
    .unwrap_err();
    assert!(
        error.contains("cannot be exported by this build"),
        "{error}"
    );
    assert!(!dest.exists());
    assert_eq!(store.user_version().unwrap(), 17);
}

#[test]
fn publication_rejects_xml_forbidden_note_caption_and_alt_characters() {
    let fixture = fixture();
    let walk = walk_scope(&fixture.store, Some(&fixture.stories[0])).unwrap();
    let book = crate::export::Book {
        publication: None,
        single_scene: false,
        name: "N",
        contents_title: "Contents",
        front: &walk.front,
        chapters: &walk.chapters,
        back: &walk.back,
    };
    let original: serde_json::Value =
        serde_json::from_str(&walk.bodies[&fixture.scenes[0]]).unwrap();
    for (field, pointer) in [
        ("note body", "/content/0/content/1/attrs/body"),
        ("caption", "/content/1/attrs/caption"),
        ("alternative text", "/content/1/attrs/alt"),
    ] {
        for invalid in [
            '\0', '\u{8}', '\u{b}', '\u{c}', '\u{e}', '\u{1f}', '\u{fffe}', '\u{ffff}',
        ] {
            let mut document = original.clone();
            *document.pointer_mut(pointer).unwrap() = json!(format!("before{invalid}after"));
            let bodies = HashMap::from([(fixture.scenes[0].clone(), document.to_string())]);
            let error = Plan::from_store(
                &book,
                &bodies,
                crate::publication_plan::Scopes::book(&book),
                &fixture.store,
                &fixture.db,
            )
            .err()
            .unwrap();
            assert!(
                error.contains(field)
                    && error.contains("XML 1.0")
                    && error.contains(&format!("U+{:04X}", invalid as u32)),
                "{error}"
            );
        }
    }
}

#[test]
fn unknown_note_numbering_does_not_block_legacy_exports_or_preflight() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    store.item_create(None, "scene", "Scene").unwrap();
    store.set_meta("notes.numbering", "future").unwrap();
    let vault = crate::identity::Vault::default();
    for format in [
        crate::export::Format::Markdown,
        crate::export::Format::Docx,
        crate::export::Format::Pdf,
        crate::export::Format::Epub,
    ] {
        render_project(
            &db,
            "Book",
            format,
            &vault,
            crate::strings::Strings::english(),
        )
        .unwrap();
        preflight_of_store(&store, "Book", format, &vault).unwrap();
    }
}

#[test]
fn scoped_markdown_uses_the_publication_plan_and_round_trips_its_package() {
    fn sequence(documents: &[serde_json::Value]) -> Vec<serde_json::Value> {
        let mut result = Vec::new();
        for block in documents.iter().flat_map(|doc| doc["content"].as_array().unwrap()) {
            if block["type"] == "scene_break" {
                result.push(block.clone());
            }
            for note in block.get("content").and_then(serde_json::Value::as_array).into_iter().flatten()
                .filter(|node| node["type"] == "endnote") {
                result.push(json!({"type":"endnote", "fmt":note["attrs"]["fmt"], "body":note["attrs"]["body"]}));
            }
        }
        result
    }
    let fixture = fixture();
    for numbering in ["book", "story", "chapter"] {
        fixture.store.set_meta("notes.numbering", numbering).unwrap();
        for story in [None, Some(fixture.stories[0].as_str())] {
            let (written, _, _, _) = render_scope_policy(&fixture.db, "Collected", crate::export::Format::Markdown,
                &crate::identity::Vault::default(), crate::strings::Strings::english(), None, story, true).unwrap();
            let text = written.text();
            assert!(text.starts_with(crate::markdown::MARKER));
            assert!(text.contains(r"\[^1\]"));
            assert!(text.contains("\n\n---\n"));
            assert!(text.contains("garret-figure:"));
            assert!(text.contains("caption 0"));
            check_destination_mode(&written, Dest::New).unwrap();
            let refusal = check_destination_mode(&written, Dest::Replace).unwrap_err();
            assert!(refusal.contains("cannot use Export as or replace files"), "{refusal}");
            let expected = with_plan(&fixture, story, |_, walk, plan| {
                let documents: Vec<_> = walk.front.iter().chain(&walk.chapters).chain(&walk.back)
                    .filter_map(|(id, _, _)| plan.documents.get(id).cloned()).collect();
                sequence(&documents)
            });
            assert_eq!(written.assets.len(), if story.is_some() { 1 } else { 2 });
            if story.is_some() { assert!(!text.contains("note 1")); assert!(!text.contains("caption 1")); }
            let package = tempfile::tempdir().unwrap();
            let dest = package.path().join("book.md");
            crate::markdown_package::publish(&dest, &written.bytes, &written.assets).unwrap();
            for (path, bytes) in &written.assets {
                assert!(path.starts_with("assets/")); assert!(!Path::new(path).is_absolute());
                assert_eq!(std::fs::read(package.path().join(path)).unwrap(), *bytes);
            }
            let parsed = crate::import::read_package(text, "book", package.path()).unwrap();
            assert_eq!(parsed.assets, written.assets);
            assert_eq!(parsed.asset_ids.len(), written.assets.len());
            let bodies: Vec<serde_json::Value> = parsed.imported.items.iter().filter_map(|item|
                item.body.as_ref().map(|body| serde_json::from_str(body).unwrap())).collect();
            assert_eq!(sequence(&bodies), expected);
            for figure in bodies.iter().flat_map(|doc| doc["content"].as_array().unwrap()).filter(|node| node["type"] == "figure") {
                assert!(parsed.asset_ids.values().any(|id| figure["attrs"]["asset_id"] == *id));
                assert!(!fixture.assets.iter().any(|asset| figure["attrs"]["asset_id"] == asset.id));
            }
            let serialized = serde_json::to_string(&bodies).unwrap();
            assert!(serialized.contains("A literal [^1] & 😀"));
            assert!(serialized.contains("second <line>"));
            assert!(serialized.contains("A \\\"quoted\\\" <view> & sky"));
            assert!(serialized.contains("\"width\":\"page\""));
            let notes: Vec<_> = bodies.iter().flat_map(|doc| doc["content"].as_array().unwrap()).flat_map(|block|
                block.get("content").and_then(serde_json::Value::as_array).into_iter().flatten())
                .filter(|node| node["type"] == "endnote").collect();
            assert_eq!(notes.len(), if story.is_some() { 4 } else { 6 });
            let ids: std::collections::HashSet<_> = notes.iter().map(|node| node["attrs"]["id"].as_str().unwrap()).collect();
            assert_eq!(ids.len(), notes.len());
            assert!(!ids.contains("0199ed16-8c00-7000-8000-000000000001"));
            let third = text.lines().any(|line| line.starts_with("[^s") && line.split_once("]: ").is_some_and(|(key, _)| key.ends_with("-3")));
            if numbering == "chapter" { assert!(!third); }
            if numbering == "story" { assert!(third); }
        }
    }
}

#[test]
fn markdown_conversion_stays_disabled_before_any_publication_or_import_writes() {
    let fixture = fixture();
    let dest = fixture.root.path().join("refused.md");
    let before = fixture.store.documents().unwrap();
    assert!(export_as(&fixture.db, "Collected", &dest, crate::export::Format::Markdown,
        &crate::identity::Vault::default(), crate::strings::Strings::english()).is_err());
    assert!(!dest.exists()); assert!(!fixture.root.path().join("assets").exists());
    assert!(check_save_as(&fixture.db, "Collected", crate::export::Format::Markdown,
        &crate::identity::Vault::default(), crate::strings::Strings::english(), None).is_err());
    let source = fixture.root.path().join("source.md");
    std::fs::write(&source, format!("{}# Book\n\n## Scene\n\ntext[^s1-1]\n\n[^s1-1]: note\n", crate::markdown::MARKER)).unwrap();
    let library = fixture.root.path().join("library");
    let home = fixture.root.path().join("home");
    let error = crate::import_path(&home, &library, &source, &crate::strings::Strings::english()).err().unwrap();
    assert!(error.contains("new-format Markdown conversion is disabled"), "{error}");
    assert!(!library.exists()); assert!(!home.exists());
    assert_eq!(fixture.store.documents().unwrap(), before);
    assert_eq!(fixture.store.user_version().unwrap(), 17);
    assert!(!store::document_format::new_nodes_allowed());
}

#[test]
fn mirror_fixture_copies_require_the_new_schema_and_use_relative_hashed_assets() {
    let fixture = fixture();
    with_plan(&fixture, Some(&fixture.stories[0]), |_, _, plan| {
        let item = fixture.store.items().unwrap().into_iter().find(|item| item.id == fixture.scenes[0]).unwrap();
        assert!(crate::mirror::planned_file(&item, 17, plan).is_err());
        assert!(crate::mirror::planned_file(&item, 19, plan).is_err());
        rusqlite::Connection::open(&fixture.db).unwrap().pragma_update(None, "user_version", 18).unwrap();
        let schema = fixture.store.user_version().unwrap();
        assert_eq!(schema, 18);
        let copy = crate::mirror::planned_file(&item, schema, plan).unwrap();
        assert!(copy.text().contains("document_format: 18\n"));
        assert_eq!(copy.assets.len(), 1);
        for path in copy.assets.keys() {
            assert!(path.starts_with("assets/"));
            assert!(path.contains(&fixture.assets[0].sha256));
            assert!(!Path::new(path).is_absolute());
        }
        let out = tempfile::tempdir().unwrap();
        crate::markdown_package::publish(&out.path().join("scene.md"), &copy.bytes, &copy.assets).unwrap();
        let old = crate::mirror::read_file(copy.text()).unwrap();
        assert_eq!(old.extra, ["document_format"]);
        let body = copy.text().split_once("---\n\n").unwrap().1;
        let package = format!("{}{body}", crate::markdown::MARKER);
        let parsed = crate::import::read_package(&package, "scene", out.path()).unwrap();
        assert_eq!(parsed.assets, copy.assets);
        assert!(parsed.imported.items.iter().filter_map(|item| item.body.as_ref()).any(|body| body.contains("endnote")));
        let legacy = crate::mirror::file_body(&item, Some(&fixture.store.load_doc(&item.id).unwrap().body));
        assert!(!legacy.contains("document_format:"));
        assert!(!store::document_format::new_nodes_allowed());
        let disabled = fixture.root.path().join("production-mirror");
        assert!(crate::mirror::pass(&fixture.db, "book", "Book", &disabled, 0, &Default::default()).is_err());
        assert!(!disabled.exists());
    });
}

#[test]
fn pdf_publication_reuses_scopes_assets_and_refuses_disabled_production() {
    let fixture = fixture();
    for numbering in ["book", "chapter", "story"] {
        fixture.store.set_meta("notes.numbering", numbering).unwrap();
        for selected in [false, true] {
            let story = selected.then_some(fixture.stories[0].as_str());
            with_plan(&fixture, story, |book, _, plan| {
                let (written, _, _, _) = render_scope_policy(&fixture.db, "Collected", crate::export::Format::Pdf,
                    &crate::identity::Vault::default(), crate::strings::Strings::english(), None, story, true).unwrap();
                let html = written.text();
                let flow = html.split("<div id=\"proof-flow\">\n").nth(1).unwrap().split("</div>\n<div id=\"proof-leaves\">").next().unwrap();
                for note in &plan.notes {
                    assert!(flow.contains(&format!("<sup class=\"proof-noteref\">{}</sup>", note.number)));
                    assert!(flow.contains(&format!("<p class=\"proof-note\">{}. {}", note.number, crate::epub::xml_escape(&note.body))));
                }
                for (end, groups) in &plan.endnotes {
                    let rows: Vec<_> = book.front.iter().chain(book.chapters).chain(book.back).collect();
                    let end_index = rows.iter().position(|row| row.0 == *end).unwrap();
                    let begin = flow.find(&format!("id=\"{}\"", crate::pdf::anchor_id(end))).unwrap();
                    let limit = rows.get(end_index + 1).map(|row| flow.find(&format!("id=\"{}\"", crate::pdf::anchor_id(&row.0))).unwrap()).unwrap_or(flow.len());
                    let after_heading = &flow[begin..limit];
                    assert_eq!(after_heading.matches("<p class=\"proof-note\">").count(), groups.values().map(Vec::len).sum::<usize>());
                    for notes in groups.values() { for index in notes {
                        assert!(after_heading.contains(&format!("<p class=\"proof-note\">{}. {}", plan.notes[*index].number, crate::epub::xml_escape(&plan.notes[*index].body))));
                    }}
                }
                assert!(flow.contains("data-proof-leaf=\"interior\""));
                assert!(flow.contains("role=\"separator\""));
                assert!(flow.contains("Mixed legacy prose"));
                assert!(!flow.contains("<p><figure"));
                assert!(flow.contains("alt=\"A &quot;quoted&quot; &lt;view&gt; &amp; sky\""));
                assert_eq!(flow.matches("data:image/png;base64,").count(), 2);
                assert_eq!(flow.contains("data:image/jpeg;base64,"), !selected);
                if selected { assert!(!flow.contains("note 1")); assert!(!flow.contains("caption 1")); }
            });
        }
    }
    let dest = fixture.root.path().join("refused.pdf");
    assert!(export_as(&fixture.db, "Collected", &dest, crate::export::Format::Pdf,
        &crate::identity::Vault::default(), crate::strings::Strings::english()).is_err());
    assert!(!dest.exists());
    assert_eq!(fixture.store.user_version().unwrap(), 17);
    assert!(!store::document_format::new_nodes_allowed());
}
