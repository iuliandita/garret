// app/shell-tauri/src-tauri/src/replace.rs
// Rewriting a word across the whole manuscript.
//
// This was refused in as many words: an operation with no inverse, performed on
// the thing the application exists to protect. The inverse was built, and the
// spending of it is the whole of this module's safety argument -- the store
// method that calls this takes a NAMED SNAPSHOT of every document, in the same
// transaction, before a single body is written.
//
// PER TEXT NODE, AND THAT IS THE REFUSAL RULE RATHER THAN AN IMPLEMENTATION
// DETAIL. A match confined to one text node cannot cross a block boundary and
// cannot cross a mark boundary, because both of those ARE node boundaries in
// this schema. So a replacement written inside one node inherits exactly the
// emphasis the matched words already carried, and can never concatenate two
// paragraphs -- which is what `tr.replaceWith` over such a range does in the
// page, and what a naive projection-level rewrite would do here.
//
// The cost is real and is REPORTED rather than hidden: a match that spans a
// paragraph break or the edge of an italicised run is left alone and counted.
// Told "replaced 47" while a forty-eighth is still there, a writer has been
// misled and the reason is not something they could work out.
use crate::find;

#[derive(Debug, PartialEq, Eq)]
pub struct BodyReplacement {
    /// The rewritten body, or None when nothing in it matched. None is not an
    /// empty rewrite: the caller must not bump a document's revision, write a
    /// version or touch its row for a document it did not change.
    pub body: Option<String>,
    pub replaced: usize,
    /// Matches present in the document's PROJECTED text but not inside any one
    /// text node -- so, spanning a block or a mark. Left alone, on purpose.
    pub spanning: usize,
}

/// Replace every occurrence of `query` (already folded and trimmed by
/// `find::normalize_query`) inside one stored body.
///
/// Returns `None` for a body this build cannot read as a document, exactly as
/// the word count does: an unreadable body is skipped rather than rewritten,
/// because rewriting something we cannot parse is how a manuscript is
/// destroyed.
pub fn replace_in_body(body: &str, query: &str, replacement: &str) -> Option<BodyReplacement> {
    if query.is_empty() {
        return Some(BodyReplacement {
            body: None,
            replaced: 0,
            spanning: 0,
        });
    }
    let mut root: serde_json::Value = serde_json::from_str(body).ok()?;
    if root.get("type").and_then(|t| t.as_str()) != Some("doc") {
        return None;
    }
    // The projection FIRST, so the spanning count is computed against the same
    // text `project_find` searched -- the figure the writer was shown.
    let projected = projected_text(&root);
    let total = find::count_matches(&projected, query);

    let mut replaced = 0usize;
    rewrite_node(&mut root, query, replacement, &mut replaced);

    let changed = replaced > 0;
    Some(BodyReplacement {
        body: if changed {
            serde_json::to_string(&root).ok()
        } else {
            None
        },
        replaced,
        // saturating: per-node counting can never EXCEED the projection's,
        // since every in-node match is also a match of the concatenation, but
        // the two count non-overlapping runs independently and a subtraction
        // that could go negative is a subtraction that should say so quietly
        // rather than panic in a write transaction.
        spanning: total.saturating_sub(replaced),
    })
}

/// The same projection `store::document_text` builds, restated here because
/// this module must not depend on the store and the store must not depend on
/// this. Text nodes concatenated with nothing; one separator before each
/// non-text node's content, none before the first.
fn projected_text(root: &serde_json::Value) -> String {
    let mut out = String::new();
    append(root, &mut out);
    out
}

fn append(node: &serde_json::Value, out: &mut String) {
    if node.get("type").and_then(|t| t.as_str()) == Some("text") {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
        return;
    }
    if !out.is_empty() {
        out.push(' ');
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            append(child, out);
        }
    }
}

fn rewrite_node(
    node: &mut serde_json::Value,
    query: &str,
    replacement: &str,
    replaced: &mut usize,
) {
    if node.get("type").and_then(|t| t.as_str()) == Some("text") {
        let Some(text) = node.get("text").and_then(|t| t.as_str()) else {
            return;
        };
        let (next, n) = replace_in_text(text, query, replacement);
        if n > 0 {
            *replaced += n;
            if let Some(obj) = node.as_object_mut() {
                obj.insert("text".to_string(), serde_json::Value::String(next));
            }
        }
        return;
    }
    if let Some(children) = node.get_mut("content").and_then(|c| c.as_array_mut()) {
        for child in children {
            rewrite_node(child, query, replacement, replaced);
        }
    }
}

/// One text node's own text, and how many occurrences were rewritten.
///
/// FOLD-AWARE through `find::fold_with_offsets`, shared with the search rather
/// than restated: a replace folding differently from the search would rewrite
/// words the writer never saw highlighted.
///
/// Non-overlapping, left to right, and the output is built by APPENDING rather
/// than by editing in place -- the recorded back-to-front rule exists because
/// editing in place shifts every position after the edit. Building a new string
/// forwards has no such hazard and needs no reversal.
fn replace_in_text(text: &str, query: &str, replacement: &str) -> (String, usize) {
    let (folded, map) = find::fold_with_offsets(text);
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut n = 0usize;
    let mut at = folded.find(query);
    while let Some(found) = at {
        let from = map[found];
        let to = map[found + query.len()];
        // A fold that changes length can map two folded positions onto one
        // original offset. Skipping such a match is right: there is no range of
        // the ORIGINAL text that corresponds to it, so any rewrite would be a
        // guess about the writer's characters.
        if from >= cursor && to > from {
            out.push_str(&text[cursor..from]);
            out.push_str(replacement);
            cursor = to;
            n += 1;
        }
        let next = found + query.len();
        at = folded[next..].find(query).map(|i| i + next);
    }
    out.push_str(&text[cursor..]);
    (out, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(paragraphs: &[&[(&str, bool)]]) -> String {
        let content: Vec<serde_json::Value> = paragraphs
            .iter()
            .map(|runs| {
                let nodes: Vec<serde_json::Value> = runs
                    .iter()
                    .map(|(text, em)| {
                        if *em {
                            serde_json::json!({"type":"text","text":text,"marks":[{"type":"em"}]})
                        } else {
                            serde_json::json!({"type":"text","text":text})
                        }
                    })
                    .collect();
                serde_json::json!({"type":"paragraph","content":nodes})
            })
            .collect();
        serde_json::json!({"type":"doc","content":content}).to_string()
    }

    fn text_of(body: &str) -> String {
        let root: serde_json::Value = serde_json::from_str(body).unwrap();
        projected_text(&root)
    }

    #[test]
    fn every_occurrence_in_a_paragraph_is_rewritten() {
        let body = doc(&[&[("the moon over the moonlit road", false)]]);
        let out = replace_in_body(&body, "moon", "sun").unwrap();
        assert_eq!(out.replaced, 2);
        assert_eq!(text_of(&out.body.unwrap()), "the sun over the sunlit road");
    }

    #[test]
    fn a_document_with_no_match_is_not_rewritten_at_all() {
        // None, not an identical rewrite: the caller must not bump a revision,
        // write a version or touch the row of a document it did not change.
        let body = doc(&[&[("nothing here", false)]]);
        let out = replace_in_body(&body, "moon", "sun").unwrap();
        assert_eq!(out.replaced, 0);
        assert_eq!(out.body, None);
    }

    #[test]
    fn matching_is_case_insensitive_and_the_replacement_is_verbatim() {
        let body = doc(&[&[("Moonlight and MOONS", false)]]);
        let out = replace_in_body(&body, "moon", "sun").unwrap();
        assert_eq!(out.replaced, 2);
        assert_eq!(text_of(&out.body.unwrap()), "sunlight and sunS");
    }

    #[test]
    fn a_match_spanning_a_paragraph_break_is_LEFT_ALONE_and_counted() {
        // Rewriting it would concatenate the two paragraphs -- silently, in the
        // writer's manuscript.
        let body = doc(&[&[("the cat", false)], &[("sat down", false)]]);
        let out = replace_in_body(&body, "cat sat", "dog lay").unwrap();
        assert_eq!(out.replaced, 0);
        assert_eq!(out.spanning, 1);
        assert_eq!(out.body, None);
    }

    #[test]
    fn a_match_spanning_an_emphasis_boundary_is_LEFT_ALONE_and_counted() {
        // "be" + italic "witched": the application cannot know which half of the
        // emphasis the writer meant the replacement to carry.
        let body = doc(&[&[("be", false), ("witched", true)]]);
        let out = replace_in_body(&body, "bewitched", "enchanted").unwrap();
        assert_eq!(out.replaced, 0);
        assert_eq!(out.spanning, 1);
    }

    #[test]
    fn a_replacement_inside_an_emphasised_run_keeps_the_emphasis() {
        let body = doc(&[&[("she was ", false), ("moonstruck", true)]]);
        let out = replace_in_body(&body, "moon", "sun").unwrap();
        let rewritten: serde_json::Value = serde_json::from_str(&out.body.unwrap()).unwrap();
        let run = &rewritten["content"][0]["content"][1];
        assert_eq!(run["text"], "sunstruck");
        assert_eq!(run["marks"][0]["type"], "em");
    }

    #[test]
    fn the_spanning_count_is_reported_alongside_the_replacements() {
        // Both in one document: one ordinary match and one across the break.
        let body = doc(&[&[("the cat and the cat", false)], &[("sat", false)]]);
        let out = replace_in_body(&body, "cat", "dog").unwrap();
        assert_eq!(out.replaced, 2);
        assert_eq!(out.spanning, 0, "a single word cannot span a break");
    }

    #[test]
    fn an_unreadable_body_is_skipped_rather_than_rewritten() {
        // Rewriting something we cannot parse is how a manuscript is destroyed.
        assert_eq!(replace_in_body("not json at all", "a", "b"), None);
        assert_eq!(replace_in_body(r#"{"type":"note"}"#, "a", "b"), None);
    }

    #[test]
    fn an_empty_query_rewrites_nothing_rather_than_everything() {
        let body = doc(&[&[("some prose", false)]]);
        let out = replace_in_body(&body, "", "X").unwrap();
        assert_eq!((out.replaced, out.spanning), (0, 0));
        assert_eq!(out.body, None);
    }

    #[test]
    fn overlapping_occurrences_are_counted_once_each_left_to_right() {
        let body = doc(&[&[("aaaa", false)]]);
        let out = replace_in_body(&body, "aa", "b").unwrap();
        assert_eq!(out.replaced, 2);
        assert_eq!(text_of(&out.body.unwrap()), "bb");
    }

    #[test]
    fn a_replacement_longer_than_the_match_does_not_shift_later_matches() {
        // The recorded left-to-right hazard, which is why the output is BUILT
        // rather than edited in place. Editing in place would land each later
        // replacement progressively further into the prose.
        let body = doc(&[&[("x cat y cat z cat", false)]]);
        let out = replace_in_body(&body, "cat", "elephant").unwrap();
        assert_eq!(out.replaced, 3);
        assert_eq!(
            text_of(&out.body.unwrap()),
            "x elephant y elephant z elephant"
        );
    }

    #[test]
    fn replace_folds_EXACTLY_as_the_search_does_including_where_that_misses() {
        // The recorded Greek cost, from the replace side: folding is per
        // CHARACTER, so capital sigma lowercases to medial σ while a word-final
        // ς is left as it is. "ΟΔΟΣ" and "οδος" therefore do NOT fold together.
        //
        // The claim is NOT that the miss is good. It is that find and replace
        // MISS IDENTICALLY, because they share `fold_with_offsets`. A replace
        // folding a whole string with `to_lowercase` would match BOTH spellings
        // and rewrite a word the writer never saw highlighted.
        let body = doc(&[&[("ΟΔΟΣ και οδος", false)]]);
        for query in ["οδος", "οδοσ"] {
            let out = replace_in_body(&body, query, "ΔΡΟΜΟΣ").unwrap();
            // count_matches does NO folding of its own -- it is the scan's
            // inner loop and the caller has always folded both sides. Passing
            // the raw text here made the comparison a comparison of two
            // different things, and it reported the replace as over-eager when
            // it was the test that was wrong.
            let (haystack, _) = find::fold_with_offsets(&text_of(&body));
            let found = find::count_matches(&haystack, query);
            assert_eq!(
                out.replaced + out.spanning,
                found,
                "query {query:?}: replace saw {} replaced + {} spanning, find saw {found}",
                out.replaced,
                out.spanning,
            );
            assert_eq!(
                out.replaced, 1,
                "query {query:?} matches exactly one spelling"
            );
        }
    }

    #[test]
    fn a_multibyte_match_maps_back_to_character_boundaries() {
        let body = doc(&[&[("café au café", false)]]);
        let out = replace_in_body(&body, "café", "tea").unwrap();
        assert_eq!(out.replaced, 2);
        assert_eq!(text_of(&out.body.unwrap()), "tea au tea");
    }
}
