use super::*;

#[test]
fn xml_preflight_and_export_share_cleaned_blockers_and_warning_tokens() {
    use crate::identity::{Identity, Pin, Public, Vault};
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    let scene = store.item_create(None, "scene", "\u{1}Ada\u{b}Vane").unwrap();
    let body = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"\u{1}Ada\u{b}Vane"}]}]}).to_string();
    store.flush(&[store::FlushEntry { item_id: scene.id.clone(), body, base_rev: scene.doc_rev.unwrap(), comments: None }]).unwrap();
    let vault = Vault { identities: vec![Identity { id: "other".into(), public: Public { name: "Ada Vane".into(), ..Default::default() }, ..Default::default() }], ..Default::default() };
    for format in [crate::export::Format::Epub, crate::export::Format::Docx] {
        let pin = Pin { identity_id: "mine".into(), public: Public { name: "My\u{b}Name".into(), ..Default::default() }, publishing: crate::identity::Publishing { imprint: "My\u{1}Press".into(), rights: String::new() }, ..Default::default() };
        store.set_meta(crate::core_constants::PIN_KEY, &serde_json::to_string(&pin).unwrap()).unwrap();
        let report = preflight_of_store(&store, "Book", format, &vault).unwrap();
        assert!(report.blockers > 0);
        assert!(report.findings.iter().any(|finding| finding.surface == "document_body" && finding.matched == "Ada Vane"));
        assert!(report.fields.iter().all(|field| !field.value.contains(['\u{1}', '\u{b}'])));
        assert_eq!(render_project(&db, "Book", format, &vault, crate::strings::Strings::english()).err().unwrap(), crate::identity::blocked_message(&report.findings));
        store.delete_meta(crate::core_constants::PIN_KEY).unwrap();
        let report = preflight_of_store(&store, "Book", format, &vault).unwrap();
        let token = report.warning_tokens.iter().find(|token| report.findings[token.finding_index].surface == "item_title").unwrap();
        let finding = &report.findings[token.finding_index];
        assert_eq!(finding.offset, Some(0));
        assert_eq!(finding.matched, "Ada Vane");
        store.with_immediate(|store| crate::warning_history::append(store, &report, &token.token, "Intentional reference", 42)).unwrap();
        let (_, _, _, exported, _) = render_project(&db, "Book", format, &vault, crate::strings::Strings::english()).unwrap();
        assert_eq!(report.warning_tokens, exported.warning_tokens);
        assert_eq!(exported.reason_history, crate::warning_history::read(&store).unwrap());
        store.with_immediate(|store| crate::warning_history::append(store, &exported, &token.token, "Still intentional", 43)).unwrap();
    }
}

#[test]
fn xml_identity_needles_clean_names_sort_names_aliases_and_owned_names() {
    use crate::identity::{Identity, Pin, Public, Subject, Vault};
    for field in 0..3 {
        let mut other = Identity { id: "other".into(), ..Default::default() };
        match field {
            0 => other.public.name = "Ada\u{b}Vane".into(),
            1 => other.public.sort_name = "Ada\u{b}Vane".into(),
            _ => other.aliases = vec!["Ada\u{b}Vane".into()],
        }
        let mut vault = Vault { identities: vec![other], ..Default::default() };
        let pin = Pin { identity_id: "mine".into(), ..Default::default() };
        assert_eq!(crate::identity::check(&Subject { format: crate::export::Format::Markdown, project_name: "Ada Vane", titles: &[], bodies: &[], planning: &[], pin: Some(&pin), vault: &vault }).blockers, 0);
        for format in [crate::export::Format::Epub, crate::export::Format::Docx] {
            let check = |vault: &Vault| crate::identity::check(&Subject { format, project_name: "Ada Vane", titles: &[], bodies: &[], planning: &[], pin: Some(&pin), vault });
            assert!(check(&vault).blockers > 0);
            vault.identities.push(Identity { id: "mine".into(), public: Public { name: "Ada\u{1} Vane".into(), ..Default::default() }, ..Default::default() });
            assert_eq!(check(&vault).blockers, 0);
            vault.identities.pop();
        }
    }
}

#[test]
fn xml_scoped_author_falls_back_to_pin_and_drops_cleaned_empty_bylines() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    store.set_meta("project.preset", "collection").unwrap();
    let story = store.item_create(None, "chapter", "Story").unwrap();
    store.item_create(Some(&story.id), "scene", "Scene").unwrap();
    for format in [crate::export::Format::Epub, crate::export::Format::Docx] {
        for (author, pin_name, expected) in [(None, "Pin\u{b}Name", Some("Pin Name")), (None, "\u{1}", None), (Some("\u{1}"), "Pin Name", None)] {
            let key = format!("collection.author.{}", story.id);
            if let Some(author) = author { store.set_meta(&key, author).unwrap(); } else { store.delete_meta(&key).unwrap(); }
            let pin = crate::identity::Pin { public: crate::identity::Public { name: pin_name.into(), ..Default::default() }, ..Default::default() };
            store.set_meta(crate::core_constants::PIN_KEY, &serde_json::to_string(&pin).unwrap()).unwrap();
            let (written, _, _, report, removed) = render_scope_with(&db, "Book", format, &crate::identity::Vault::default(), crate::strings::Strings::english(), None, Some(&story.id)).unwrap();
            let xml = xml_parts(&written);
            assert_eq!(removed, 1);
            let bylines: Vec<_> = report.fields.iter().filter(|field| field.at == "title-page").map(|field| field.value.as_str()).collect();
            assert_eq!(bylines, expected.into_iter().collect::<Vec<_>>());
            if let Some(expected) = expected { assert!(xml.contains(expected)); }
            else {
                assert!(!xml.contains("<dc:creator"));
                assert!(!xml.contains("<p class=\"story-byline\">"));
                assert!(!xml.contains("<w:jc w:val=\"center\"/></w:pPr><w:r><w:t xml:space=\"preserve\"></w:t>"));
            }
        }
    }
}

pub(super) fn xml_parts(written: &crate::export::Manuscript) -> String {
    let entries = crate::epub::read_zip(&written.bytes).unwrap();
    let mut all = String::new();
    for (path, bytes) in entries {
        if ![".xml", ".xhtml", ".opf", ".ncx", ".rels"].iter().any(|suffix| path.ends_with(suffix)) {
            continue;
        }
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.chars().all(|c| matches!(c,
            '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}'
        )), "forbidden XML character in {path}: {text:?}");
        let mut reader = quick_xml::Reader::from_str(&text);
        reader.config_mut().check_comments = true;
        loop {
            match reader.read_event().unwrap_or_else(|error| panic!("{path}: {error}")) {
                quick_xml::events::Event::Eof => break,
                _ => {}
            }
        }
        all.push_str(&text);
    }
    assert!(!all.is_empty());
    all
}

#[test]
fn xml_metadata_cleanup_covers_titles_and_identity_without_writing_the_book() {
    static LOCALE: crate::strings::Locale = crate::strings::Locale::new("en", &[
        ("book.contents", "Con\u{1}tents\u{b}label"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    store.set_meta("project.preset", "collection").unwrap();
    let dirty = |label: &str| format!("{label}\u{1}\u{b}& <é😀>");
    let part = store.item_create(None, "part", &dirty("Part")).unwrap();
    let chapter = store.item_create(Some(&part.id), "chapter", &dirty("Chapter")).unwrap();
    let scene = store.item_create(Some(&chapter.id), "scene", &dirty("Scene")).unwrap();
    store.item_create(None, "scene", "Second scene").unwrap();
    for (kind, label) in [(store::FRONT_MATTER_TYPE, "Dedication"), (store::BACK_MATTER_TYPE, "References")] {
        let container = store.item_create(None, kind, "Matter").unwrap();
        store.item_create(Some(&container.id), "matter", &dirty(label)).unwrap();
    }
    let body = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":dirty("Prose")}]}]}).to_string();
    store.flush(&[store::FlushEntry { item_id: scene.id.clone(), body: body.clone(), base_rev: scene.doc_rev.unwrap(), comments: None }]).unwrap();
    let pin = crate::identity::Pin {
        public: crate::identity::Public { name: dirty("Author"), sort_name: dirty("Sort"), ..Default::default() },
        publishing: crate::identity::Publishing { imprint: dirty("Press"), rights: dirty("Rights") },
        ..Default::default()
    };
    let stored_pin = serde_json::to_string(&pin).unwrap();
    store.set_meta(crate::core_constants::PIN_KEY, &stored_pin).unwrap();
    let titles: Vec<_> = store.items().unwrap().into_iter().map(|item| (item.id, item.title, item.rev)).collect();
    let book = dirty("Book");
    let before = std::fs::read(&db).unwrap();
    for format in [crate::export::Format::Epub, crate::export::Format::Docx, crate::export::Format::Markdown] {
        let (written, _, _, preflight, removed) = render_project(&db, &book, format, &crate::identity::Vault::default(), crate::strings::Strings::new(&LOCALE)).unwrap();
        if format == crate::export::Format::Markdown {
            assert_eq!(removed, 0);
            assert!(String::from_utf8(written.bytes).unwrap().contains('\u{1}'));
        } else {
            assert_eq!(removed, if format == crate::export::Format::Epub { 24 } else { 16 });
            let xml = xml_parts(&written);
            for label in ["Book", "Part", "Chapter", "Dedication", "References", "Prose"] {
                assert!(xml.contains(&format!("{label} &amp; &lt;é😀&gt;")), "{format:?}: missing {label}");
            }
            assert!(xml.contains("Contents label"));
            if format == crate::export::Format::Epub {
                assert!(preflight.fields.iter().all(|field| !field.value.contains(['\u{1}', '\u{b}'])));
                for label in ["Author", "Sort", "Press", "Rights"] {
                    assert!(xml.contains(&format!("{label} &amp; &lt;é😀&gt;")), "missing {label}");
                }
            }
        }
        assert_eq!(store.items().unwrap().into_iter().map(|item| (item.id, item.title, item.rev)).collect::<Vec<_>>(), titles);
        assert_eq!(store.load_doc(&scene.id).unwrap().body, body);
        assert_eq!(store.get_meta(crate::core_constants::PIN_KEY).unwrap().as_deref(), Some(stored_pin.as_str()));
        assert_eq!(std::fs::read(&db).unwrap(), before);
    }
}

#[test]
fn xml_collection_cleanup_covers_whole_book_and_scoped_story_bylines() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("book.db");
    let store = store::Store::open(&db).unwrap();
    store.set_meta("project.preset", "collection").unwrap();
    let story = store.item_create(None, "chapter", "St\u{1}ory\u{b}title").unwrap();
    store.item_create(Some(&story.id), "scene", "Scene").unwrap();
    store.item_create(Some(&story.id), "scene", "Another scene").unwrap();
    let key = format!("collection.author.{}", story.id);
    store.set_meta(&key, "Au\u{1}thor\u{b}name").unwrap();
    for format in [crate::export::Format::Epub, crate::export::Format::Docx] {
        for scope in [None, Some(story.id.as_str())] {
            let (written, _, _, _, removed) = render_scope_with(&db, "Collection", format, &crate::identity::Vault::default(), crate::strings::Strings::english(), None, scope).unwrap();
            assert_eq!(removed, 4, "{format:?} {scope:?}");
            let xml = xml_parts(&written);
            assert!(xml.contains("Story title"));
            assert!(xml.contains("Author name"));
            assert_eq!(store.items().unwrap().into_iter().find(|item| item.id == story.id).unwrap().title, "St\u{1}ory\u{b}title");
            assert_eq!(store.get_meta(&key).unwrap().as_deref(), Some("Au\u{1}thor\u{b}name"));
        }
    }
}
