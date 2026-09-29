// app/shell-tauri/src-tauri/src/find.rs
// Manuscript-wide search, as pure functions. No I/O, no `Store`, no `Path`.
//
// The scan is LINEAR and deliberately unindexed. The drafting-essentials slice
// measured the per-document word index being built at open by scanning and
// JSON-parsing every stored body: ~58 ms at `stress` over 15,200 documents and
// 1.9 M words. Search does that same scan plus a substring compare, so an FTS5
// virtual table would buy nothing measurable and would cost a whole category of
// index-disagrees-with-store defect, plus a schema migration. SCHEMA_VERSION is
// unchanged by this.
use std::collections::HashMap;

/// Items returned to the page for one query. Chosen by what the results panel
/// can render without becoming a second virtual list, not by what the scan
/// costs -- the scan is linear either way.
pub const DEFAULT_LIMIT: usize = 200;

/// Characters of context kept either side of the match in a snippet.
const SNIPPET_CONTEXT_CHARS: usize = 48;

/// Marks a snippet that does not start at the beginning of its text, and one
/// that does not run to the end.
const ELLIPSIS: char = '\u{2026}';

/// One item as the search sees it. Deliberately NOT `store::Item`: `find.rs`
/// depends on no other module, for the same reason `export.rs` takes tuples.
#[derive(Debug, Clone, Copy)]
pub struct SearchItem<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
}

/// Every readable document's prose, already projected to plain text by the
/// caller, plus what that projection cost.
///
/// `skipped` mirrors the figure `word_index` already reports and exists for the
/// same reason: a body that is not a readable document is excluded from the
/// answer, and a total that silently omits it is a total nobody can check.
#[derive(Debug, Default)]
pub struct Corpus {
    pub texts: HashMap<String, String>,
    pub scanned: usize,
    pub skipped: usize,
}

#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct FindHit {
    pub item_id: String,
    pub title: String,
    pub kind: String,
    pub snippet: String,
    /// Occurrences in this item's prose. 0 for a title-only hit.
    pub matches: usize,
    pub title_match: bool,
    /// Whether the row can be OPENED rather than merely selected. A part or
    /// chapter that matched is still shown and still selects its navigator row.
    ///
    /// `store::carries_document`, never the literal `"scene"`. It was the
    /// literal at first, which is why a bible note has been findable and
    /// unopenable from this panel -- the one rule that answers "does
    /// this row hold prose" lives in the store and this is the third caller of
    /// it. A fourth type must not have to remember this line exists.
    pub openable: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct FindResults {
    pub results: Vec<FindHit>,
    /// Items that matched, BEFORE the cap. The cap is honest, not silent: a
    /// truncation nobody is told about reads as "covered everything".
    pub total: usize,
    pub truncated: bool,
    pub scanned: usize,
    pub skipped: usize,
}

/// The ONE case-folding rule in this module, applied to the query and to every
/// text it is compared against.
///
/// Per CHARACTER, deliberately, and not `str::to_lowercase`. The two are not the
/// same function: `str::to_lowercase` is context-dependent -- a Greek capital
/// sigma lowercases to the final form when it ends a word and the medial form
/// otherwise -- while `char::to_lowercase` always yields the medial form. Using
/// one to test containment and the other to locate the match would let a
/// document report a hit at an offset the other folding does not have, and the
/// snippet cut would then run off a character boundary and PANIC.
///
/// The cost is a real, narrow limit: a query typed with a word-final Greek sigma
/// does not match text written with the medial form, or the reverse. Rust's
/// standard library has no case-folding operation (`toCaseFold`), which is what
/// would settle it properly. Recorded rather than hidden.
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        for lowered in ch.to_lowercase() {
            out.push(lowered);
        }
    }
    out
}

/// The query as the scan will use it: trimmed, folded, or `None` when there is
/// nothing to search for.
///
/// An empty query returns no results rather than every document. Matching the
/// empty string against a manuscript would return the whole book and read as a
/// catastrophic bug; refusing it is not an error the writer needs to see.
pub fn normalize_query(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(fold(trimmed))
}

/// Non-overlapping occurrences of `needle` in `haystack`. Both must already be
/// folded by the caller; this function does no folding of its own.
pub fn count_matches(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

/// `fold(original)`, plus a map from every byte offset of the folded text back
/// to a byte offset in `original`.
///
/// The map exists because folding is NOT length-preserving, in bytes or in
/// chars: Turkish dotted capital I folds to two characters, and several Greek
/// and German forms change byte length. So a byte offset located in the folded
/// text is not a valid index into the original, and slicing the original at one
/// is a PANIC rather than an error -- it would poison the store mutex, and
/// `locked()` exits the process rather than serve a store in an unknown state.
/// **A bad snippet cut would close the writer's window**, which is why the
/// fixture corpus being mixed-script (Hebrew, Arabic, `é`, `ê`, `ß`) is load
/// bearing here rather than incidental.
///
/// `map[i]` is the start offset of the original character that produced byte
/// `i` of the folded text, so every value is a character boundary by
/// construction. One extra entry holds `original.len()`, so a match ending at
/// the very end of the text maps without a bounds check at the call site.
///
/// The returned string is `fold(original)` exactly; a test pins that, because
/// the whole scheme collapses if the two ever fold differently.
/// SHARED WITH `replace.rs`, deliberately, and this is one of the few places in
/// this repo where sharing rather than restating is the right call. Find and
/// replace MUST agree on what a match is: a replace folding differently from
/// the search would rewrite words the writer never saw highlighted, which is
/// the one thing a search-and-replace must not do.
pub(crate) fn fold_with_offsets(original: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(original.len());
    let mut map = Vec::with_capacity(original.len() + 1);
    for (offset, ch) in original.char_indices() {
        let before = folded.len();
        for lowered in ch.to_lowercase() {
            folded.push(lowered);
        }
        for _ in before..folded.len() {
            map.push(offset);
        }
    }
    map.push(original.len());
    (folded, map)
}

/// A one-line excerpt of `text` around the byte range `start..end`, with
/// `SNIPPET_CONTEXT_CHARS` either side and an ellipsis on any edge that was cut.
///
/// The returned text is an EXACT substring of `text` apart from those two
/// ellipsis characters. Nothing is collapsed or normalized, which is what lets
/// `find_snippet_fidelity` be a strict containment check rather than a
/// comparison of two normalizations -- the export slice recorded what it costs
/// when a gate's two sides are both normalized until a real difference cannot
/// show through. The projection this reads has no newlines to collapse anyway:
/// text nodes cannot contain one and blocks are joined by a single space.
///
/// # Panics
/// If `start`/`end` are not character boundaries of `text`. Every caller in
/// this module obtains them from `fold_with_offsets`, which cannot produce one
/// that is not.
pub fn snippet(text: &str, start: usize, end: usize) -> String {
    let lead: Vec<usize> = text[..start]
        .char_indices()
        .rev()
        .take(SNIPPET_CONTEXT_CHARS)
        .map(|(i, _)| i)
        .collect();
    let from = lead.last().copied().unwrap_or(start);

    let tail = text[end..]
        .char_indices()
        .take(SNIPPET_CONTEXT_CHARS)
        .last()
        .map(|(i, c)| end + i + c.len_utf8())
        .unwrap_or(end);

    let mut out = String::new();
    if from > 0 {
        out.push(ELLIPSIS);
    }
    out.push_str(&text[from..tail]);
    if tail < text.len() {
        out.push(ELLIPSIS);
    }
    out
}

/// The whole search: walk order in, at most `limit` hits out, with the true
/// total beside them.
///
/// Ordering is the caller's -- `items()` returns the depth-first walk, which is
/// the book's own order. There is no ranking and the panel does not claim one.
pub fn search(items: &[SearchItem<'_>], corpus: &Corpus, query: &str, limit: usize) -> FindResults {
    let mut out = FindResults {
        results: Vec::new(),
        total: 0,
        truncated: false,
        scanned: corpus.scanned,
        skipped: corpus.skipped,
    };
    let Some(needle) = normalize_query(query) else {
        return out;
    };

    for item in items {
        let title_match = fold(item.title).contains(&needle);

        // Containment is tested on the cheap folded copy; the offset map is
        // built only for the documents that actually matched.
        let text = corpus.texts.get(item.id);
        let prose = text.and_then(|t| {
            let folded = fold(t);
            if folded.contains(&needle) {
                Some(t.as_str())
            } else {
                None
            }
        });

        if !title_match && prose.is_none() {
            continue;
        }
        out.total += 1;
        if out.results.len() >= limit {
            out.truncated = true;
            continue;
        }

        let (snippet_text, matches) = match prose {
            // The prose snippet is preferred over the title even when both
            // matched: it carries the context a writer is actually looking for.
            Some(original) => {
                let (folded, map) = fold_with_offsets(original);
                // `contains` above already answered this; `unwrap_or(0)` is a
                // total function rather than a claim that a miss is impossible.
                let at = folded.find(&needle).unwrap_or(0);
                (
                    snippet(original, map[at], map[at + needle.len()]),
                    count_matches(&folded, &needle),
                )
            }
            // EMPTY, not the title. A title-only hit has no prose to excerpt,
            // and returning the title as its own snippet renders as the same
            // string twice in one result row -- which a screenshot showed
            // immediately and no test could, because "the snippet equals the
            // title" was exactly what the test asserted. The page shows the
            // item's type in that slot instead, which says why it matched.
            None => (String::new(), 0),
        };

        out.results.push(FindHit {
            item_id: item.id.to_string(),
            title: item.title.to_string(),
            kind: item.kind.to_string(),
            snippet: snippet_text,
            matches,
            title_match,
            openable: crate::store::carries_document(item.kind),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item<'a>(id: &'a str, kind: &'a str, title: &'a str) -> SearchItem<'a> {
        SearchItem { id, kind, title }
    }

    fn corpus(entries: &[(&str, &str)]) -> Corpus {
        Corpus {
            texts: entries
                .iter()
                .map(|(id, text)| ((*id).to_string(), (*text).to_string()))
                .collect(),
            scanned: entries.len(),
            skipped: 0,
        }
    }

    // -- the folding rule -------------------------------------------------

    #[test]
    fn fold_with_offsets_agrees_with_fold() {
        // The whole offset scheme collapses if these two ever fold differently,
        // and the difference would show up as a panic in a snippet cut rather
        // than as a wrong answer. Includes the cases where folding changes
        // length: Turkish dotted capital I becomes two chars.
        for s in [
            "",
            "plain",
            "MiXeD CaSe",
            "\u{130}stanbul",
            "Stra\u{df}e CAF\u{c9}",
            "\u{5e9}\u{5dc}\u{5d5}\u{5dd} WORLD",
            "\u{3a3}\u{39f}\u{3a6}\u{39f}\u{3a3}",
        ] {
            let (folded, _) = fold_with_offsets(s);
            assert_eq!(folded, fold(s), "disagreement on {s:?}");
        }
    }

    #[test]
    fn fold_is_deliberately_not_str_to_lowercase() {
        // The obvious simplification of `fold` is `s.to_lowercase()`, and it is
        // wrong in a way nothing else in this suite would catch: `str` folding
        // is CONTEXT-DEPENDENT. A Greek capital sigma at the end of a word
        // becomes the final form, and the same character elsewhere becomes the
        // medial form; `char` folding always yields the medial form.
        //
        // Mixing the two would let a document report a hit at an offset the
        // other folding does not have, and the snippet cut would then run off a
        // character boundary and PANIC -- which poisons the store mutex and
        // exits the process, closing the writer's window.
        //
        // This test exists so that simplification goes red instead of shipping.
        let word = "\u{3a3}\u{39f}\u{3a6}\u{39f}\u{3a3}"; // greek capitals
        assert_ne!(
            fold(word),
            word.to_lowercase(),
            "str::to_lowercase stopped being context-dependent; re-derive the \
             offset scheme before simplifying fold()"
        );
        assert_eq!(fold(word), "\u{3c3}\u{3bf}\u{3c6}\u{3bf}\u{3c3}");
    }

    #[test]
    fn the_folding_limit_is_symmetric_and_therefore_harmless_to_offsets() {
        // The cost of the choice above, stated as a test rather than only as
        // prose: a query typed with a word-final sigma does not match text
        // written with the medial form. Narrow, real, and recorded. What
        // matters is that BOTH sides fold the same way, so no offset can be
        // located in one folding and applied to the other.
        let items = [item("s1", "scene", "x")];
        let c = corpus(&[("s1", "\u{3a3}\u{39f}\u{3a6}\u{39f}\u{3a3}")]);
        // The medial form, which is what fold() produces on both sides.
        assert_eq!(
            search(&items, &c, "\u{3c3}\u{3bf}\u{3c6}\u{3bf}\u{3c3}", 10).total,
            1
        );
        // The final form, which fold() never produces. Documented miss.
        assert_eq!(
            search(&items, &c, "\u{3c3}\u{3bf}\u{3c6}\u{3bf}\u{3c2}", 10).total,
            0
        );
    }

    #[test]
    fn every_offset_maps_to_a_character_boundary() {
        // A value that is not a boundary is exactly the panic this map exists
        // to prevent, so it is asserted directly rather than inferred from the
        // snippets happening to come out right.
        let original = "\u{5e9}\u{5dc}\u{5d5}\u{5dd} Stra\u{df}e \u{130}z CAF\u{c9}";
        let (folded, map) = fold_with_offsets(original);
        assert_eq!(map.len(), folded.len() + 1);
        for (i, &offset) in map.iter().enumerate() {
            assert!(
                original.is_char_boundary(offset),
                "map[{i}] = {offset} is not a character boundary of {original:?}",
            );
        }
        assert_eq!(*map.last().unwrap(), original.len());
    }

    #[test]
    fn folding_that_changes_length_still_maps_back() {
        // U+0130 is one char and two bytes; it folds to two chars and three
        // bytes. A map that assumed length preservation would land mid-char.
        let original = "a\u{130}b";
        let (folded, map) = fold_with_offsets(original);
        assert!(folded.len() > original.len());
        let at = folded.find('b').unwrap();
        assert_eq!(map[at], original.find('b').unwrap());
    }

    // -- normalize_query --------------------------------------------------

    #[test]
    fn an_empty_query_is_none_rather_than_a_match_on_everything() {
        assert_eq!(normalize_query(""), None);
        assert_eq!(normalize_query("   "), None);
        assert_eq!(normalize_query("\t\n "), None);
    }

    #[test]
    fn a_query_is_trimmed_and_folded() {
        assert_eq!(normalize_query("  Winter  ").as_deref(), Some("winter"));
    }

    #[test]
    fn interior_whitespace_is_kept() {
        // Trimming the edges is a courtesy to a writer who typed a trailing
        // space; collapsing the middle would change which phrases can be found.
        assert_eq!(normalize_query("  the  inn  ").as_deref(), Some("the  inn"));
    }

    // -- count_matches ----------------------------------------------------

    #[test]
    fn matches_are_counted_without_overlapping() {
        assert_eq!(count_matches("aaaa", "aa"), 2);
        assert_eq!(count_matches("abcabc", "abc"), 2);
        assert_eq!(count_matches("abcabc", "z"), 0);
    }

    #[test]
    fn an_empty_needle_counts_zero_rather_than_once_per_position() {
        assert_eq!(count_matches("abc", ""), 0);
    }

    // -- snippet ----------------------------------------------------------

    #[test]
    fn a_short_text_is_returned_whole_with_no_ellipses() {
        let text = "The innkeeper waited.";
        let start = text.find("innkeeper").unwrap();
        let out = snippet(text, start, start + "innkeeper".len());
        assert_eq!(out, text);
    }

    #[test]
    fn a_cut_edge_is_marked_and_an_uncut_edge_is_not() {
        let text = format!("{}MATCH{}", "a".repeat(200), "b".repeat(200));
        let start = text.find("MATCH").unwrap();
        let out = snippet(&text, start, start + 5);
        assert!(out.starts_with(ELLIPSIS), "leading cut unmarked: {out:?}");
        assert!(out.ends_with(ELLIPSIS), "trailing cut unmarked: {out:?}");

        let head = format!("MATCH{}", "b".repeat(200));
        let out = snippet(&head, 0, 5);
        assert!(
            !out.starts_with(ELLIPSIS),
            "marked a cut that did not happen"
        );
        assert!(out.ends_with(ELLIPSIS));
    }

    #[test]
    fn a_snippet_is_an_exact_substring_apart_from_its_ellipses() {
        // This is what lets find_snippet_fidelity be a strict containment check
        // rather than a comparison of two normalizations.
        let text = format!("{}needle{}", "x ".repeat(80), " y".repeat(80));
        let start = text.find("needle").unwrap();
        let out = snippet(&text, start, start + 6);
        let stripped = out.trim_matches(ELLIPSIS);
        assert!(text.contains(stripped), "{stripped:?} not in the text");
    }

    #[test]
    fn a_snippet_cut_inside_multibyte_text_does_not_panic() {
        // The fixture corpus is mixed-script by construction. A byte-indexed
        // cut here is a process-ending panic, not a wrong answer.
        let text = format!(
            "{}\u{5e9}\u{5dc}\u{5d5}\u{5dd}{}",
            "\u{5d0}\u{5d1}\u{5d2} ".repeat(60),
            " \u{627}\u{644}\u{628}".repeat(60),
        );
        let start = text.find('\u{5e9}').unwrap();
        let out = snippet(&text, start, start + '\u{5e9}'.len_utf8() * 4);
        assert!(out.contains('\u{5e9}'));
    }

    // -- search -----------------------------------------------------------

    #[test]
    fn prose_and_titles_are_both_searched() {
        let items = [
            item("p1", "part", "The Winter Book"),
            item("s1", "scene", "Arrival"),
        ];
        let c = corpus(&[("s1", "She reached the inn at dusk.")]);

        let by_title = search(&items, &c, "winter", DEFAULT_LIMIT);
        assert_eq!(by_title.total, 1);
        assert_eq!(by_title.results[0].item_id, "p1");
        assert!(by_title.results[0].title_match);
        assert_eq!(by_title.results[0].matches, 0);

        let by_prose = search(&items, &c, "inn", DEFAULT_LIMIT);
        assert_eq!(by_prose.total, 1);
        assert_eq!(by_prose.results[0].item_id, "s1");
        assert!(!by_prose.results[0].title_match);
    }

    #[test]
    fn a_part_matching_by_title_is_returned_though_it_holds_no_prose() {
        // Restricting search to prose would silently exclude every part and
        // chapter in the book, which is where a writer looks first.
        let items = [item("c1", "chapter", "The Innkeeper")];
        let out = search(&items, &corpus(&[]), "innkeeper", DEFAULT_LIMIT);
        assert_eq!(out.total, 1);
        assert_eq!(out.results[0].kind, "chapter");
        assert!(!out.results[0].openable);
    }

    #[test]
    fn a_title_only_hit_carries_no_snippet_rather_than_repeating_its_title() {
        // Found by SCREENSHOT, not by a test. The first version returned the
        // title as the snippet, so a title-only row rendered the same string
        // twice, one line under the other. Nothing in this suite could see it:
        // "the snippet equals the title" was the behaviour, so any test of it
        // would have asserted the defect.
        let items = [item("p1", "part", "The Winter Book")];
        let out = search(&items, &corpus(&[]), "winter", DEFAULT_LIMIT);
        assert_eq!(out.results[0].snippet, "");
        assert!(out.results[0].title_match);
        assert_eq!(out.results[0].matches, 0);
    }

    #[test]
    /// EVERY TYPE THAT HOLDS PROSE, not the literal `"scene"`. A bible note and
    /// a matter document are documents a writer opens, and a result list that
    /// found one and refused to open it is a dead end the panel offered.
    fn every_type_that_holds_a_document_is_openable() {
        let items = [
            item("s1", "scene", "Match"),
            item("n1", crate::store::NOTE_TYPE, "Match"),
            item("m1", crate::store::MATTER_TYPE, "Match"),
            item("p1", "part", "Match"),
            item("d1", "doc", "Match"),
        ];
        let out = search(&items, &corpus(&[]), "match", DEFAULT_LIMIT);
        let openable: Vec<bool> = out.results.iter().map(|h| h.openable).collect();
        assert_eq!(openable, vec![true, true, true, false, false]);
    }

    #[test]
    fn matching_is_case_insensitive_in_both_directions() {
        let items = [item("s1", "scene", "Arrival")];
        let c = corpus(&[("s1", "The INNKEEPER waited.")]);
        for q in ["innkeeper", "INNKEEPER", "InNkEePeR"] {
            assert_eq!(search(&items, &c, q, DEFAULT_LIMIT).total, 1, "query {q:?}");
        }
    }

    #[test]
    fn an_empty_query_returns_nothing_and_is_not_an_error() {
        let items = [item("s1", "scene", "Arrival")];
        let c = corpus(&[("s1", "Anything at all.")]);
        let out = search(&items, &c, "   ", DEFAULT_LIMIT);
        assert_eq!(out.total, 0);
        assert!(out.results.is_empty());
        assert!(!out.truncated);
    }

    #[test]
    fn results_come_back_in_the_order_the_items_were_given() {
        // items() returns the depth-first walk, so that order is the book's.
        // There is no ranking and the panel does not claim one.
        let items = [
            item("a", "scene", "match one"),
            item("b", "scene", "match two"),
            item("c", "scene", "match three"),
        ];
        let out = search(&items, &corpus(&[]), "match", DEFAULT_LIMIT);
        let ids: Vec<&str> = out.results.iter().map(|h| h.item_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn the_cap_truncates_the_list_and_reports_the_true_total() {
        let titles: Vec<String> = (0..10).map(|i| format!("match {i}")).collect();
        let items: Vec<SearchItem<'_>> = titles
            .iter()
            .map(|t| SearchItem {
                id: t,
                kind: "scene",
                title: t,
            })
            .collect();
        let out = search(&items, &corpus(&[]), "match", 3);
        assert_eq!(out.results.len(), 3);
        assert_eq!(out.total, 10, "the total must count past the cap");
        assert!(out.truncated);
    }

    #[test]
    fn an_uncapped_result_set_is_not_marked_truncated() {
        // The failing direction of the gate above: without this, `truncated =
        // true` unconditionally would pass every truncation assertion.
        let items = [item("a", "scene", "match")];
        let out = search(&items, &corpus(&[]), "match", 3);
        assert_eq!(out.total, 1);
        assert!(!out.truncated);
    }

    #[test]
    fn the_prose_snippet_is_preferred_when_both_title_and_prose_match() {
        let items = [item("s1", "scene", "The Inn")];
        let c = corpus(&[("s1", "She reached the inn at dusk and stayed.")]);
        let out = search(&items, &c, "inn", DEFAULT_LIMIT);
        let hit = &out.results[0];
        assert!(hit.title_match, "the title matched too and must say so");
        assert!(
            hit.snippet.contains("at dusk"),
            "expected prose context, got {:?}",
            hit.snippet
        );
    }

    #[test]
    fn the_snippet_is_cut_at_the_match_not_at_the_start_of_the_document() {
        // Found by mutation: `snippet(original, 0, 0)` -- a snippet that ignores
        // where the match is and always shows the opening of the scene --
        // survived the whole suite. Every other snippet test used a document
        // short enough that the whole text IS the snippet, so the opening and
        // the match were the same string.
        //
        // A writer searching a 5,000-word scene and being shown its first
        // sentence every time is the feature failing at its only job, and no
        // gate above could see it.
        let items = [item("s1", "scene", "Arrival")];
        let text = format!(
            "{}the innkeeper waited{}",
            "opening. ".repeat(40),
            " x".repeat(40)
        );
        let c = corpus(&[("s1", text.as_str())]);
        let out = search(&items, &c, "innkeeper", DEFAULT_LIMIT);
        let snip = &out.results[0].snippet;
        assert!(
            snip.contains("innkeeper"),
            "the match itself is missing: {snip:?}"
        );
        assert!(
            snip.starts_with(ELLIPSIS),
            "the snippet began at the start of the document rather than being cut \
             back from the match: {snip:?}"
        );
    }

    #[test]
    fn a_match_at_the_very_end_maps_without_running_off_the_text() {
        // The end sentinel in the offset map is what makes this safe; without
        // it this is an out-of-bounds index rather than a wrong answer.
        let items = [item("s1", "scene", "Arrival")];
        let c = corpus(&[("s1", "the road ended at the INN")]);
        let out = search(&items, &c, "inn", DEFAULT_LIMIT);
        assert_eq!(out.total, 1);
        assert!(out.results[0].snippet.ends_with("INN"));
    }

    #[test]
    fn occurrences_within_one_document_are_counted() {
        let items = [item("s1", "scene", "Arrival")];
        let c = corpus(&[("s1", "inn, inn, and inn again")]);
        let out = search(&items, &c, "inn", DEFAULT_LIMIT);
        assert_eq!(out.total, 1, "one item, however many occurrences");
        assert_eq!(out.results[0].matches, 3);
    }

    #[test]
    fn the_scan_figures_are_carried_through() {
        // skipped is the only figure saying the total is an undercount; a
        // search that dropped it would report a complete-looking answer.
        let c = Corpus {
            texts: HashMap::new(),
            scanned: 12,
            skipped: 5,
        };
        let out = search(&[], &c, "anything", DEFAULT_LIMIT);
        assert_eq!(out.scanned, 12);
        assert_eq!(out.skipped, 5);
    }

    #[test]
    fn a_match_may_span_a_block_boundary() {
        // document_text joins blocks with a single space, so this is reachable
        // and is the honest behaviour rather than a defect. Pinned so a future
        // change to the projection cannot alter it silently.
        let items = [item("s1", "scene", "Arrival")];
        let c = corpus(&[("s1", "He shut the door. She waited.")]);
        assert_eq!(search(&items, &c, "door. She", DEFAULT_LIMIT).total, 1);
    }
}
