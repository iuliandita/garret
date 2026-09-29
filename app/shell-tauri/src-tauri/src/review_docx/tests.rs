use super::*;
use std::collections::BTreeSet;

fn text(value: &str) -> FragmentToken {
    FragmentToken::Text {
        text: value.into(),
        marks: Vec::new(),
    }
}
fn prose(value: &str) -> String {
    body(&[FragmentToken::Open, text(value), FragmentToken::Close]).unwrap()
}
fn snapshot() -> SceneSnapshot {
    SceneSnapshot {
        book_id: "book-fixture".into(),
        item_id: "scene-fixture".into(),
        doc_rev: 4,
        body: prose("one"),
        groups: Vec::new(),
        ordinary_comments: Vec::new(),
    }
}
fn proposal(source: &str, hunk: ReviewHunk) -> SceneSnapshot {
    let mut snapshot = snapshot();
    snapshot.body = source.into();
    snapshot.groups.push(GroupSnapshot {
        id: 3,
        rev: 2,
        author_name: "Rae".into(),
        created_at: 1_790_328_000_000,
        hunks: vec![HunkSnapshot {
            id: 7,
            state: "pending".into(),
            from: hunk.from,
            to: hunk.to,
            original: hunk,
        }],
        messages: Vec::new(),
    });
    snapshot
}
fn cases() -> Vec<serde_json::Value> {
    let mut cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../harness/fixtures/review-documents.json"
    ))
    .unwrap();
    cases.extend(
        serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "tests/fixtures/extra-documents.json"
        ))
        .unwrap(),
    );
    cases
}
fn case_source(case: &serde_json::Value) -> SceneSnapshot {
    let mut source = proposal(
        &case["body"].to_string(),
        serde_json::from_value(case["hunk"].clone()).unwrap(),
    );
    if let Some(message) = case.get("message") {
        source.groups[0]
            .messages
            .push(serde_json::from_value(message.clone()).unwrap());
    }
    source
}

fn document_fixture(bytes: &[u8]) -> document::Parsed {
    document::parse(
        &xml::parse(bytes, &mut xml::Budget::default()).unwrap(),
        "fixture",
    )
    .unwrap()
}
fn replace_part(bytes: &[u8], name: &str, change: impl FnOnce(String) -> String) -> Vec<u8> {
    let mut parts = zip::read(bytes).unwrap();
    let source = String::from_utf8(parts.remove(name).unwrap()).unwrap();
    parts.insert(name.into(), change(source).into_bytes());
    crate::package_format::zip(
        &parts
            .into_iter()
            .map(|(name, bytes)| crate::package_format::Entry { name, bytes })
            .collect::<Vec<_>>(),
    )
}

#[test]
fn review_docx_handwritten_namespace_and_structural_projections() {
    let parsed = document_fixture(include_bytes!("tests/fixtures/handwritten.xml"));
    let rejected = document::project(&parsed.events, &BTreeSet::new()).unwrap();
    let accepted = document::project(
        &parsed.events,
        &parsed.revisions.iter().map(|r| r.key).collect(),
    )
    .unwrap();
    assert_eq!(
        rejected.tokens,
        vec![
            FragmentToken::Open,
            text(" A😀 old"),
            FragmentToken::Text {
                text: "tail".into(),
                marks: vec![Mark::Strong]
            },
            FragmentToken::Close,
            FragmentToken::Open,
            FragmentToken::Close
        ]
    );
    assert_eq!(
        accepted.tokens,
        vec![
            FragmentToken::Open,
            text(" A😀 "),
            FragmentToken::Text {
                text: "new".into(),
                marks: vec![Mark::Strong, Mark::Underline]
            },
            FragmentToken::Close,
            FragmentToken::Open,
            FragmentToken::Text {
                text: "tail".into(),
                marks: vec![Mark::Em]
            },
            FragmentToken::Close,
            FragmentToken::Open,
            FragmentToken::Close
        ]
    );
}
#[test]
fn review_docx_independent_python_docx_preserves_marks_empty_and_whitespace() {
    let parsed = document_fixture(include_bytes!("tests/fixtures/python-docx.xml"));
    assert!(parsed.revisions.is_empty());
    assert_eq!(
        document::project(&parsed.events, &BTreeSet::new())
            .unwrap()
            .tokens,
        vec![
            FragmentToken::Open,
            text("  A😀 "),
            FragmentToken::Text {
                text: "marked".into(),
                marks: vec![Mark::Em, Mark::Strong, Mark::Underline]
            },
            FragmentToken::Close,
            FragmentToken::Open,
            FragmentToken::Close,
            FragmentToken::Open,
            text(" "),
            FragmentToken::Close
        ]
    );
}
#[test]
fn review_docx_shared_independent_host_transformations_export_as_real_revisions() {
    for case in &cases() {
        if case["expected"].is_null() {
            continue;
        }
        let source = case_source(case);
        let result = export(&source).unwrap_or_else(|e| panic!("{}: {e}", case["id"]));
        let plan = inspect_return(&result.bytes, &source).unwrap();
        assert!(result.manifest.tag.len() <= 64);
        let parts = zip::read(&result.bytes).unwrap();
        let xml = xml::parse(&parts["word/document.xml"], &mut xml::Budget::default()).unwrap();
        fn unique_revision_ids(e: &xml::Element, seen: &mut BTreeSet<String>) {
            if e.ns == xml::W && matches!(e.name.as_str(), "ins" | "del" | "rPrChange") {
                assert!(
                    seen.insert(e.required(xml::W, "id").unwrap().into()),
                    "emitted revision ids must be unique"
                );
            }
            for child in &e.children {
                unique_revision_ids(child, seen);
            }
        }
        unique_revision_ids(&xml, &mut BTreeSet::new());
        assert!(plan.decisions.is_empty(), "{}", case["id"]);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&plan.accepted_projection).unwrap(),
            case["expected"],
            "{}",
            case["id"]
        );
    }
}
#[test]
fn review_docx_pending_comments_and_disclosure_are_exact() {
    let mut source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 2,
            before: vec![text("o")],
            after: vec![text("O")],
        },
    );
    source.groups[0].messages.push(MessageSnapshot {
        id: 9,
        author_name: "Lee".into(),
        body: "Keep the space.\nSecond line.".into(),
        created_at: 0,
    });
    let package = export(&source).unwrap();
    assert_eq!(package.disclosure.authors, vec!["Lee", "Rae"]);
    assert_eq!(
        package.disclosure.messages[0].body,
        source.groups[0].messages[0].body
    );
    let changed = replace_part(&package.bytes, "word/comments.xml", |xml| {
        xml.replace("Second line.", "Edited.")
    });
    assert!(inspect_return(&changed, &source).is_err());
    let removed = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace("<w:commentRangeEnd w:id=\"9\"/>", "")
    });
    assert!(inspect_return(&removed, &source).is_err());
}
#[test]
fn review_docx_manifest_baseline_mapping_and_untracked_changes_refuse() {
    let source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 2,
            before: vec![text("o")],
            after: vec![text("O")],
        },
    );
    let package = export(&source).unwrap();
    for (part, from, to) in [
        ("word/document.xml", "ne</w:t>", "changed</w:t>"),
        ("word/document.xml", "bookmarkEnd", "lostEnd"),
        (
            "_rels/.rels",
            "Target=\"word/document.xml\"",
            "Target=\"https://example.org/document.xml\"",
        ),
        ("docProps/custom.xml", "book-fixture", "other-book"),
    ] {
        let altered = replace_part(&package.bytes, part, |xml| {
            assert!(xml.contains(from));
            xml.replace(from, to)
        });
        assert!(inspect_return(&altered, &source).is_err(), "{part}: {from}");
    }
    let mut stale = source.clone();
    stale.doc_rev += 1;
    assert!(inspect_return(&package.bytes, &stale).is_err());
}
#[test]
fn review_docx_zip_rejects_duplicates_paths_flags_crc_and_expansion_before_allocation() {
    let entry = |name: &str| crate::package_format::Entry {
        name: name.into(),
        bytes: b"abc".to_vec(),
    };
    for entries in [
        vec![entry("same"), entry("same")],
        vec![entry("../bad")],
        vec![entry("/bad")],
        vec![entry("a\\b")],
    ] {
        assert!(zip::read(&crate::package_format::zip(&entries)).is_err());
    }
    let bytes = crate::package_format::zip(&[entry("good")]);
    let mut crc = bytes.clone();
    crc[34] ^= 1;
    assert!(zip::read(&crc).is_err());
    let mut flags = bytes.clone();
    flags[6] = 1;
    assert!(zip::read(&flags).is_err());
    let mut size = bytes.clone();
    let directory =
        u32::from_le_bytes(bytes[bytes.len() - 6..bytes.len() - 2].try_into().unwrap()) as usize;
    size[directory + 24..directory + 28].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(zip::read(&size).is_err());
}
#[test]
fn review_docx_xml_rejects_dtd_entities_alias_duplicate_attributes_and_unknown_semantics() {
    for raw in [
        "<!DOCTYPE a [<!ENTITY x 'bad'>]><a>&x;</a>",
        "<a>&unknown;</a>",
        "<a><b></a>",
        "<x:a/>",
        "<a xmlns:x='urn:a' xmlns:y='urn:a' x:id='1' y:id='2'/>",
        "<a>&#0;</a>",
        "<a/><b/>",
    ] {
        assert!(
            xml::parse(raw.as_bytes(), &mut xml::Budget::default()).is_err(),
            "{raw}"
        );
    }
    let fixture =
        String::from_utf8(include_bytes!("tests/fixtures/handwritten.xml").to_vec()).unwrap();
    for (from, to) in [
        (
            "<x:r><x:t xml:space=\"preserve\">",
            "<x:r><x:rPr><x:rStyle x:val=\"HiddenBold\"/></x:rPr><x:t xml:space=\"preserve\">",
        ),
        ("<x:p/>", "<x:tbl/>"),
        ("x:author=\"Rae\"", "x:author=\"\""),
    ] {
        let altered = fixture.replace(from, to);
        let root = xml::parse(altered.as_bytes(), &mut xml::Budget::default()).unwrap();
        assert!(document::parse(&root, "fixture").is_err());
    }
}

fn returned_content(package: &[u8], content: &str) -> Vec<u8> {
    replace_part(package, "word/document.xml", |xml| {
        let (prefix, rest) = xml.split_once("<w:body>").unwrap();
        let (_, suffix) = rest.split_once("</w:body>").unwrap();
        format!("{prefix}<w:body>{content}</w:body>{suffix}")
    })
}
fn revision_xml(kind: &str, author: &str, content: &str) -> String {
    format!("<w:{kind} w:id=\"77\" w:author=\"{author}\" w:date=\"2026-09-25T12:00:00Z\">{content}</w:{kind}>")
}
#[test]
fn review_docx_returned_old_decisions_keep_host_coordinates_and_new_authorship() {
    let source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 2,
            before: vec![text("o")],
            after: vec![text("OO")],
        },
    );
    let package = export(&source).unwrap();
    let anchor = &package.manifest.anchors[0].name;
    for (value, decision) in [
        ("OO", OldDecision::Accept(7)),
        ("o", OldDecision::Reject(7)),
    ] {
        let content=format!("<w:p><w:bookmarkStart w:id=\"12\" w:name=\"{anchor}\"/><w:r><w:t>{value}</w:t></w:r><w:bookmarkEnd w:id=\"12\"/><w:r><w:t>ne</w:t></w:r></w:p>");
        let plan = inspect_return(&returned_content(&package.bytes, &content), &source).unwrap();
        assert_eq!(plan.decisions, vec![decision]);
        assert_eq!(plan.rejected_projection, prose(&format!("{value}ne")));
        assert!(plan.new_hunks.is_empty());
    }
    // New revisions inside an already accepted old range are suggestions against
    // the host's accepted body, even when Word reuses an existing revision ID.
    let insertion = revision_xml("ins", "New reviewer", "<w:r><w:t>!</w:t></w:r>");
    let content=format!("<w:p><w:bookmarkStart w:id=\"12\" w:name=\"{anchor}\"/><w:r><w:t>OO</w:t></w:r>{insertion}<w:bookmarkEnd w:id=\"12\"/><w:r><w:t>ne</w:t></w:r></w:p>");
    let plan = inspect_return(&returned_content(&package.bytes, &content), &source).unwrap();
    assert_eq!(plan.decisions, vec![OldDecision::Accept(7)]);
    assert_eq!(plan.rejected_projection, prose("OOne"));
    assert_eq!(plan.new_hunks.len(), 1);
    assert_eq!(plan.new_hunks[0].author_name, "New reviewer");
    assert_eq!(
        (plan.new_hunks[0].hunk.from, plan.new_hunks[0].hunk.to),
        (3, 3)
    );
    assert_eq!(
        review_document::apply_hunk(&plan.rejected_projection, &plan.new_hunks[0].hunk).unwrap(),
        prose("OO!ne")
    );
}
#[test]
fn review_docx_independent_return_units_preserve_text_formatting_and_paragraphs() {
    let source = snapshot();
    let package = export(&source).unwrap();
    let ins = revision_xml("ins", "New reviewer", "<w:r><w:t>N</w:t></w:r>");
    let del = revision_xml("del", "New reviewer", "<w:r><w:delText>n</w:delText></w:r>");
    let boundary="<w:pPr><w:rPr><w:ins w:id=\"77\" w:author=\"New reviewer\" w:date=\"2026-09-25T12:00:00Z\"/></w:rPr></w:pPr>";
    let cases=vec![
        (format!("<w:p><w:r><w:t>one</w:t></w:r>{ins}</w:p>"),prose("oneN")),
        (format!("<w:p><w:r><w:t>o</w:t></w:r>{del}<w:r><w:t>e</w:t></w:r></w:p>"),prose("oe")),
        (format!("<w:p><w:r><w:t>o</w:t></w:r>{del}{ins}<w:r><w:t>e</w:t></w:r></w:p>"),prose("oNe")),
        (format!("<w:p>{boundary}<w:r><w:t>o</w:t></w:r></w:p><w:p><w:r><w:t>ne</w:t></w:r></w:p>"),body(&[FragmentToken::Open,text("o"),FragmentToken::Close,FragmentToken::Open,text("ne"),FragmentToken::Close]).unwrap()),
        (format!("<w:p>{boundary}<w:r><w:t>one</w:t></w:r></w:p><w:p>{ins}</w:p>"),body(&[FragmentToken::Open,text("one"),FragmentToken::Close,FragmentToken::Open,text("N"),FragmentToken::Close]).unwrap()),
        (format!("<w:p>{boundary}<w:r><w:t>one</w:t></w:r></w:p><w:p/>"),body(&[FragmentToken::Open,text("one"),FragmentToken::Close,FragmentToken::Open,FragmentToken::Close]).unwrap()),
        ("<w:p><w:r><w:rPr><w:i/><w:b/><w:u w:val=\"single\"/><w:rPrChange w:id=\"77\" w:author=\"New reviewer\"><w:rPr/></w:rPrChange></w:rPr><w:t>one</w:t></w:r></w:p>".into(),body(&[FragmentToken::Open,FragmentToken::Text{text:"one".into(),marks:vec![Mark::Em,Mark::Strong,Mark::Underline]},FragmentToken::Close]).unwrap()),
    ];
    for (content, wanted) in cases {
        let plan = inspect_return(&returned_content(&package.bytes, &content), &source)
            .unwrap_or_else(|e| panic!("{content}: {e}"));
        assert_eq!(plan.new_hunks.len(), 1, "{content}");
        assert_eq!(
            review_document::apply_hunk(&source.body, &plan.new_hunks[0].hunk).unwrap(),
            wanted,
            "{content}"
        );
    }
    let first = revision_xml("del", "Rae", "<w:r><w:delText>o</w:delText></w:r>");
    let second = revision_xml("del", "Rae", "<w:r><w:delText>n</w:delText></w:r>");
    let plan = inspect_return(
        &returned_content(
            &package.bytes,
            &format!("<w:p>{first}{second}<w:r><w:t>e</w:t></w:r></w:p>"),
        ),
        &source,
    )
    .unwrap();
    assert_eq!(
        plan.new_hunks.len(),
        2,
        "adjacent same-author revisions stay separate"
    );
}

#[test]
fn review_docx_independent_complete_packages_match_authoritative_baselines() {
    for (bytes, raw) in [
        (
            include_bytes!("tests/fixtures/handwritten.docx").as_slice(),
            include_str!("tests/fixtures/handwritten-body.json"),
        ),
        (
            include_bytes!("tests/fixtures/python-docx.docx").as_slice(),
            include_str!("tests/fixtures/python-docx-body.json"),
        ),
    ] {
        let mut source = snapshot();
        source.body = raw.trim_end().into();
        let plan = inspect_return(bytes, &source).unwrap();
        assert_eq!(plan.rejected_projection, source.body);
        assert_eq!(plan.accepted_projection, source.body);
        assert!(
            plan.decisions.is_empty() && plan.new_hunks.is_empty() && plan.new_messages.is_empty()
        );
    }
}

#[test]
#[ignore = "writes interoperability fixtures to REVIEW_DOCX_FIXTURE_DIR"]
fn review_docx_write_interoperability_fixtures() {
    let destination = std::path::PathBuf::from(
        std::env::var_os("REVIEW_DOCX_FIXTURE_DIR").expect("explicit fixture output directory"),
    );
    std::fs::create_dir_all(&destination).unwrap();
    for case in &cases() {
        if case["expected"].is_null() {
            continue;
        }
        let source = case_source(case);
        let package = export(&source).unwrap();
        std::fs::write(
            destination.join(format!("{}.docx", case["id"].as_str().unwrap())),
            package.bytes,
        )
        .unwrap();
    }
}

#[test]
fn review_docx_original_author_revisions_cannot_become_unrecorded_decisions() {
    let source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 4,
            before: vec![text("one")],
            after: vec![text("ONE")],
        },
    );
    let package = export(&source).unwrap();
    let mutated = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace(">ONE</w:t>", ">ONX</w:t>")
    });
    assert!(inspect_return(&mutated, &source)
        .unwrap_err()
        .contains("original-author"));
    let more = revision_xml("ins", "Other", "<w:r><w:t>!</w:t></w:r>");
    let mutated = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace("<w:bookmarkEnd", &format!("{more}<w:bookmarkEnd"))
    });
    assert!(inspect_return(&mutated, &source)
        .unwrap_err()
        .contains("original-author"));
    let source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 2,
            to: 2,
            before: vec![],
            after: vec![text("X")],
        },
    );
    let package = export(&source).unwrap();
    let mutated = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace("<w:bookmarkEnd", "<w:r><w:t>X</w:t></w:r><w:bookmarkEnd")
    });
    assert!(inspect_return(&mutated, &source)
        .unwrap_err()
        .contains("original-author"));
}
#[test]
fn review_docx_comment_mapping_checks_both_projections_and_retyping_is_noop() {
    let source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 2,
            to: 2,
            before: vec![],
            after: vec![text("X")],
        },
    );
    let package = export(&source).unwrap();
    let anchor = &package.manifest.anchors[0].name;
    let ins = revision_xml("ins", "Other", "<w:r><w:t>Z</w:t></w:r>");
    let content=format!("<w:p><w:r><w:t>o</w:t></w:r><w:bookmarkStart w:id=\"1\" w:name=\"{anchor}\"/><w:bookmarkEnd w:id=\"1\"/><w:commentRangeStart w:id=\"99\"/>{ins}<w:commentRangeEnd w:id=\"99\"/><w:r><w:commentReference w:id=\"99\"/></w:r><w:r><w:t>ne</w:t></w:r></w:p>");
    let returned = returned_content(&package.bytes, &content);
    let returned = replace_part(&returned, "word/comments.xml", |xml| {
        xml.replace("</w:comments>","<w:comment w:id=\"99\" w:author=\"Other\"><w:p><w:r><w:t>My new text</w:t></w:r></w:p></w:comment></w:comments>")
    });
    assert!(inspect_return(&returned, &source)
        .unwrap_err()
        .contains("comment does not identify"));
    let source = snapshot();
    let package = export(&source).unwrap();
    let del = revision_xml("del", "Other", "<w:r><w:delText>one</w:delText></w:r>");
    let ins = revision_xml("ins", "Other", "<w:r><w:t>one</w:t></w:r>");
    let plan = inspect_return(
        &returned_content(&package.bytes, &format!("<w:p>{del}{ins}</w:p>")),
        &source,
    )
    .unwrap();
    assert!(plan.new_hunks.is_empty());
    assert!(slice(&[text("abc")], 2, 1).is_err());
}
#[test]
fn review_docx_structural_discussion_limit_is_explicit() {
    let mut source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 5,
            before: vec![text("one"), FragmentToken::Close],
            after: vec![FragmentToken::Close],
        },
    );
    source.groups[0].messages.push(MessageSnapshot {
        id: 1,
        author_name: "Other".into(),
        body: "Discuss".into(),
        created_at: 0,
    });
    assert!(export(&source)
        .unwrap_err()
        .contains("comment reference outside paragraph"));
}

#[test]
fn review_docx_manifest_chunks_and_inherited_marks_fail_closed() {
    let source = snapshot();
    let package = export(&source).unwrap();
    for (before, after) in [
        ("WritingReviewManifest0000", "WritingReviewManifest0001"),
        ("WritingReviewManifestCount", "DifferentProperty"),
        ("book-fixture", "changed-book"),
    ] {
        let changed = replace_part(&package.bytes, "docProps/custom.xml", |xml| {
            xml.replace(before, after)
        });
        assert!(inspect_return(&changed, &source).is_err());
    }
    let root = xml::parse(
        zip::read(&package.bytes)
            .unwrap()
            .get("word/document.xml")
            .unwrap(),
        &mut xml::Budget::default(),
    )
    .unwrap();
    for raw in [
        format!("<w:styles xmlns:w=\"{}\"><w:docDefaults><w:rPrDefault><w:rPr><w:b/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>",xml::W),
        format!("<w:styles xmlns:w=\"{}\"><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:rPr><w:i/></w:rPr></w:style></w:styles>",xml::W),
        format!("<w:styles xmlns:w=\"{}\"><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:basedOn w:val=\"Normal\"/></w:style></w:styles>",xml::W),
    ] {
        let styles=xml::parse(raw.as_bytes(),&mut xml::Budget::default()).unwrap();
        assert!(metadata::document(&root,Some(&styles),&package.manifest.tag).is_err());
    }
}

#[test]
fn review_docx_check_saved_interoperability_fixtures() {
    let destination = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/review_docx/tests/fixtures/libreoffice-26.8");
    let mut failures = Vec::new();
    for case in &cases() {
        if case["expected"].is_null() {
            continue;
        }
        let source = case_source(case);
        let bytes =
            std::fs::read(destination.join(format!("{}.docx", case["id"].as_str().unwrap())))
                .unwrap();
        match inspect_return(&bytes, &source) {
            Ok(plan) => {
                assert!(
                    plan.decisions.is_empty()
                        && plan.new_hunks.is_empty()
                        && plan.new_messages.is_empty()
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&plan.accepted_projection).unwrap(),
                    case["expected"]
                );
            }
            Err(error) => failures.push(format!("{}: {error}", case["id"])),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    for (file, id) in [
        ("merge-shifted-bookmark.docx", "merge_paragraphs"),
        (
            "cross-delete-shifted-bookmark.docx",
            "cross_paragraph_delete",
        ),
    ] {
        let source = case_source(cases().iter().find(|c| c["id"] == id).unwrap());
        let changed = std::fs::read(destination.join("refusals").join(file)).unwrap();
        assert!(
            inspect_return(&changed, &source).is_err(),
            "a bookmark moved across unchanged text must refuse"
        );
    }
    let lost = std::fs::read(destination.join("v1-lost-manifest.docx")).unwrap();
    assert!(inspect_return(&lost, &snapshot())
        .unwrap_err()
        .contains("required review package part missing"));
}

#[test]
fn review_docx_comment_identity_is_exact_content_and_two_anchors_not_word_id() {
    let mut source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 1,
            to: 2,
            before: vec![text("o")],
            after: vec![text("O")],
        },
    );
    source.groups[0].messages.push(MessageSnapshot {
        id: 9,
        author_name: "Lee".into(),
        body: "Exact message".into(),
        created_at: 0,
    });
    let package = export(&source).unwrap();
    let changed = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace("w:id=\"9\"", "w:id=\"100\"")
    });
    let changed = replace_part(&changed, "word/comments.xml", |xml| {
        xml.replace("w:id=\"9\"", "w:id=\"100\"")
    });
    assert!(inspect_return(&changed, &source)
        .unwrap()
        .new_messages
        .is_empty());
    let mut duplicate = source.groups[0].messages[0].clone();
    duplicate.id = 10;
    source.groups[0].messages.push(duplicate);
    assert!(export(&source).unwrap_err().contains("ambiguous"));
}

#[test]
fn review_docx_unused_image_declaration_does_not_allow_image_parts() {
    let source = snapshot();
    let package = export(&source).unwrap();
    let declaration = replace_part(&package.bytes, "[Content_Types].xml", |xml| {
        xml.replace(
            "</Types>",
            "<Default Extension=\"png\" ContentType=\"image/png\"/></Types>",
        )
    });
    inspect_return(&declaration, &source).unwrap();
    let mut entries: Vec<_> = zip::read(&declaration)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| crate::package_format::Entry { name, bytes })
        .collect();
    entries.push(crate::package_format::Entry {
        name: "word/image.png".into(),
        bytes: b"image".to_vec(),
    });
    assert!(inspect_return(&crate::package_format::zip(&entries), &source)
        .unwrap_err()
        .contains("unsupported review package part"));
}
#[test]
fn review_docx_referenced_nondefault_mark_style_cannot_be_silently_lost() {
    let source = snapshot();
    let package = export(&source).unwrap();
    let document = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace(
            "<w:p>",
            "<w:p><w:pPr><w:pStyle w:val=\"Emphasis\"/></w:pPr>",
        )
    });
    let parts = zip::read(&document).unwrap();
    let root = xml::parse(&parts["word/document.xml"], &mut xml::Budget::default()).unwrap();
    let styles=xml::parse(format!("<w:styles xmlns:w=\"{}\"><w:style w:type=\"paragraph\" w:styleId=\"Emphasis\"><w:rPr><w:i/></w:rPr></w:style></w:styles>",xml::W).as_bytes(),&mut xml::Budget::default()).unwrap();
    assert!(
        metadata::document(&root, Some(&styles), &package.manifest.tag)
            .unwrap_err()
            .contains("style-derived")
    );
}
#[test]
fn review_docx_existing_comment_must_keep_its_accepted_range() {
    let mut source = proposal(
        &prose("one"),
        ReviewHunk {
            from: 2,
            to: 2,
            before: vec![],
            after: vec![text("X")],
        },
    );
    source.groups[0].messages.push(MessageSnapshot {
        id: 9,
        author_name: "Lee".into(),
        body: "Exact message".into(),
        created_at: 0,
    });
    let package = export(&source).unwrap();
    let changed = replace_part(&package.bytes, "word/document.xml", |xml| {
        xml.replace("<w:commentRangeStart w:id=\"9\"/>", "")
            .replace("</w:ins>", "</w:ins><w:commentRangeStart w:id=\"9\"/>")
    });
    assert!(inspect_return(&changed, &source)
        .unwrap_err()
        .contains("message or anchor"));
}

#[test]
fn review_docx_mixed_old_decisions_keep_pending_hunks_and_shift_new_coordinates() {
    let mut source = proposal(
        &prose("abc def ghi"),
        ReviewHunk {
            from: 1,
            to: 4,
            before: vec![text("abc")],
            after: vec![text("ABCD")],
        },
    );
    for (group_id, hunk_id, author, from, before, after) in [
        (4, 8, "Other", 5, "def", "DEF"),
        (5, 9, "Rae", 9, "ghi", "GHI"),
    ] {
        source.groups.push(GroupSnapshot {
            id: group_id,
            rev: 1,
            author_name: author.into(),
            created_at: 0,
            hunks: vec![HunkSnapshot {
                id: hunk_id,
                state: "pending".into(),
                from,
                to: from + 3,
                original: ReviewHunk {
                    from,
                    to: from + 3,
                    before: vec![text(before)],
                    after: vec![text(after)],
                },
            }],
            messages: vec![],
        });
    }
    let package = export(&source).unwrap();
    let anchor = |id: i64, content: &str| {
        let name = &package
            .manifest
            .anchors
            .iter()
            .find(|a| a.hunk_id == id)
            .unwrap()
            .name;
        format!("<w:bookmarkStart w:id=\"{id}\" w:name=\"{name}\"/>{content}<w:bookmarkEnd w:id=\"{id}\"/>")
    };
    let accepted = anchor(7, "<w:r><w:t>ABCD</w:t></w:r>");
    let pending = anchor(
        8,
        &format!(
            "{}{}",
            revision_xml("del", "Other", "<w:r><w:delText>def</w:delText></w:r>"),
            revision_xml("ins", "Other", "<w:r><w:t>DEF</w:t></w:r>")
        ),
    );
    let rejected = anchor(9, "<w:r><w:t>ghi</w:t></w:r>");
    let added = revision_xml("ins", "New", "<w:r><w:t>!</w:t></w:r>");
    let content=format!("<w:p>{accepted}<w:r><w:t xml:space=\"preserve\"> </w:t></w:r>{pending}<w:r><w:t xml:space=\"preserve\"> </w:t></w:r>{rejected}{added}</w:p>");
    let plan = inspect_return(&returned_content(&package.bytes, &content), &source).unwrap();
    assert_eq!(
        plan.decisions,
        vec![OldDecision::Accept(7), OldDecision::Reject(9)]
    );
    assert_eq!(plan.rejected_projection, prose("ABCD def ghi"));
    assert_eq!(plan.accepted_projection, prose("ABCD DEF ghi!"));
    assert_eq!(plan.new_hunks.len(), 1);
    assert_eq!(plan.new_hunks[0].author_name, "New");
    assert_eq!(
        (plan.new_hunks[0].hunk.from, plan.new_hunks[0].hunk.to),
        (13, 13)
    );
}
