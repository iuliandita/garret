// app/shell-tauri/src-tauri/src/words.rs
//
// The word-counting rule:
//
//   A word is a maximal run of characters containing no Unicode whitespace.
//   Word count is the number of such runs in the text.
//
// This rule is DELIBERATELY RESTATED here rather than shared with its
// TypeScript twin, `app/ui/src/words.ts`. The page counts the open scene from
// the live document; this side counts the project total from every stored
// body, because loading 15,200 documents into the webview to count them would
// be absurd. Two implementations of one rule drift, and the drift shows up as
// a project total that is not the sum of its scenes. A shared constant would
// HIDE that drift; a shared case table FAILS on it.
//
// So the spec's case table is tested in both languages, case for case, in the
// `#[cfg(test)]` block below and in `app/ui/test/words.test.ts`. A case added
// to one MUST be added to the other.

/// The number of words in `text`. Pure: no store, no serde.
///
/// `split_whitespace` splits on `char::is_whitespace`, which is the Unicode
/// White_Space property and yields no empty fields, so leading, trailing and
/// repeated whitespace need no special handling. That property is exactly what
/// the TypeScript side matches with `\p{White_Space}` -- verified by
/// enumerating all of U+0000..U+10FFFF in both runtimes and diffing, not
/// assumed. (Legacy JavaScript `\s` is a DIFFERENT set: it omits U+0085 and
/// wrongly includes U+FEFF.)
pub fn count_words(text: &str) -> u64 {
    text.split_whitespace().count() as u64
}

// The sentence and paragraph rules. Both are
// stated over the same text projection with one difference: blocks are joined
// by a NEWLINE (`store::document_lines`) rather than a space, so a paragraph
// boundary survives into the text. No TypeScript twin exists for these two,
// and that is deliberate: nothing on the page counts them, and a rule nobody
// calls is a guard nothing can reach.
//
//   A paragraph is a block that holds at least one word.
//
//   A sentence ends at a run of `.`, `!`, `?` or `...` -- closing quotation
//   marks and brackets may follow it -- that is followed by whitespace or by
//   the end of its paragraph. What is left of a paragraph after its last such
//   end, if it holds a word, is one more sentence.
//
// The rule is mechanical on purpose, the way the em-dash undercount is: `Dr.
// Smith` is two sentences and `"Go!" she said.` is two, and both are cases in
// the table below so the choice is pinned rather than implied.

/// The number of paragraphs in `text`, whose blocks are joined by newlines.
pub fn count_paragraphs(text: &str) -> u64 {
    text.lines().filter(|line| count_words(line) > 0).count() as u64
}

/// The number of sentences in `text`, whose blocks are joined by newlines.
pub fn count_sentences(text: &str) -> u64 {
    text.lines().map(sentences_in_paragraph).sum()
}

/// `.`, `!`, `?` and the one-character ellipsis. The ellipsis is here so that
/// `waited... nothing` and `waited\u{2026} nothing` count the same, which they
/// would not if only the three-dot spelling ended a sentence.
fn ends_a_sentence(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '\u{2026}')
}

/// What may stand between a sentence's end and the whitespace after it.
fn closes(c: char) -> bool {
    matches!(
        c,
        '"' | '\'' | '\u{201D}' | '\u{2019}' | ')' | ']' | '\u{00BB}'
    )
}

fn sentences_in_paragraph(line: &str) -> u64 {
    let mut count = 0;
    // A word has been seen since the last sentence end. `3.14`: the run of
    // terminators is inside a word, so it ends nothing and the word goes on.
    let mut open = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if ends_a_sentence(c) {
            // A run of ends (`?!`, `...`) needs no collapsing: each one that is
            // followed by another sets `open` and the last one closes it. The
            // mutation pass found a loop for it equivalent, so it is gone.
            while chars.peek().is_some_and(|&n| closes(n)) {
                chars.next();
            }
            match chars.peek() {
                Some(n) if !n.is_whitespace() => open = true,
                _ => {
                    count += 1;
                    open = false;
                }
            }
        } else if !c.is_whitespace() {
            open = true;
        }
    }
    if open {
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared case table from the design doc. Its twin lives in
    /// `app/ui/test/words.test.ts`; a case added here MUST be added there.
    /// The table is the contract between the two implementations -- it is the
    /// only thing that fails when they drift.
    ///
    /// Whitespace separators are written as escapes, not as literal
    /// characters, so a reader can see which codepoint a case is about.
    const CASES: &[(&str, &str, u64)] = &[
        ("empty", "", 0),
        ("whitespace only", "   ", 0),
        ("one word", "word", 1),
        ("two words", "two words", 2),
        ("no empty runs at the ends", "  leading and trailing  ", 3),
        ("newline is whitespace", "line\nbreak", 2),
        ("tab is whitespace", "tab\tsep", 2),
        ("NBSP is Unicode whitespace", "non\u{00A0}breaking", 2),
        ("apostrophe does not split", "don't", 1),
        ("hyphen does not split", "mother-in-law", 1),
        ("em-dash is the deliberate undercount", "em\u{2014}dash", 1),
        ("numerals count", "3.14", 1),
        ("punctuation alone still counts", "*", 1),
        ("runs collapse", "a  b", 2),
        ("line separator is whitespace", "line\u{2028}sep", 2),
        ("thin space is whitespace", "thin\u{2009}space", 2),
        (
            "a realistic sentence",
            "She set the lamp down, said nothing for a moment, and then asked him to leave.",
            16,
        ),
    ];

    #[test]
    fn the_shared_case_table_holds() {
        // Collect rather than assert per case: a drift between the two
        // implementations is diagnosed by WHICH cases moved, and an
        // `assert_eq!` in the loop reports only the first and hides the rest.
        let failures: Vec<String> = CASES
            .iter()
            .filter_map(|(label, input, expected)| {
                let got = count_words(input);
                (got != *expected)
                    .then(|| format!("{label}: {input:?} counted {got}, expected {expected}"))
            })
            .collect();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// The sentence rule's table. Each line with a comment is a choice the
    /// rule makes on purpose, not an accident of the scanner.
    const SENTENCE_CASES: &[(&str, &str, u64)] = &[
        ("empty", "", 0),
        ("whitespace only", "   ", 0),
        ("one word, no end", "Hello", 1),
        ("one sentence", "Hello.", 1),
        ("two sentences", "One. Two.", 2),
        ("an unfinished second", "One. Two", 2),
        ("no whitespace after the end: one", "One.Two", 1),
        ("a decimal is not an end", "3.14 is pi.", 1),
        (
            "an abbreviation is an end, deliberately",
            "Dr. Smith left.",
            2,
        ),
        ("a run of ends is one end", "What?! Really.", 2),
        ("three dots end", "Wait... nothing.", 2),
        ("the ellipsis character ends", "Wait\u{2026} nothing.", 2),
        ("a closing quote may follow", "\"Go.\" She went.", 2),
        (
            "a dialogue tag is its own sentence, deliberately",
            "\"Go!\" she said.",
            2,
        ),
        ("a closing bracket may follow", "(He left.)", 1),
        ("an end alone is a sentence, as it is a word", "...", 1),
        ("a paragraph end is an end", "One\nTwo", 2),
        ("an ended paragraph is not counted twice", "One.\nTwo", 2),
        ("blank lines between", "One. \n\n Two", 2),
        (
            "a realistic sentence",
            "She set the lamp down, said nothing for a moment, and then asked him to leave.",
            1,
        ),
    ];

    const PARAGRAPH_CASES: &[(&str, &str, u64)] = &[
        ("empty", "", 0),
        ("whitespace only", "   ", 0),
        ("one", "one", 1),
        ("two lines", "a\nb", 2),
        ("a blank line is not a paragraph", "a\n\nb", 2),
        ("a whitespace line is not a paragraph", "a\n \nb", 2),
        ("a newline alone", "\n", 0),
        ("words per line do not matter", "a b\nc d", 2),
        ("a trailing newline adds nothing", "one\n", 1),
        ("a space is not a paragraph break", "one two", 1),
    ];

    fn check(cases: &[(&str, &str, u64)], rule: fn(&str) -> u64) {
        let failures: Vec<String> = cases
            .iter()
            .filter_map(|(label, input, expected)| {
                let got = rule(input);
                (got != *expected)
                    .then(|| format!("{label}: {input:?} counted {got}, expected {expected}"))
            })
            .collect();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn the_sentence_table_holds() {
        check(SENTENCE_CASES, count_sentences);
    }

    #[test]
    fn the_paragraph_table_holds() {
        check(PARAGRAPH_CASES, count_paragraphs);
    }

    #[test]
    fn nbsp_alone_is_not_a_word() {
        // Not a table case, but the property the table is sampling: NBSP is
        // the most likely place for the two runtimes to disagree about what
        // "whitespace" means, so assert the separator alone rather than only
        // a string using it.
        assert_eq!(count_words("\u{00A0}"), 0);
    }
}
