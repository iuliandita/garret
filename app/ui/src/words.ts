// app/ui/src/words.ts
//
// The word-counting rule:
//
//   A word is a maximal run of characters containing no Unicode whitespace.
//   Word count is the number of such runs in the text.
//
// This rule is DELIBERATELY RESTATED here rather than shared with its Rust
// twin, `app/shell-tauri/src-tauri/src/words.rs`. The page counts the open
// scene from the live document; Rust counts the project total from every
// stored body, because loading 15,200 documents into the webview to count
// them would be absurd. Two implementations of one rule drift, and the drift
// shows up as a project total that is not the sum of its scenes. A shared
// constant would HIDE that drift; a shared case table FAILS on it.
//
// So the spec's case table is tested in both languages, case for case, in
// `app/ui/test/words.test.ts` and in the `#[cfg(test)]` block of `words.rs`.
// A case added to one MUST be added to the other.

// `\p{White_Space}` is the Unicode White_Space property, which is exactly the
// set Rust's `char::is_whitespace` (and therefore `split_whitespace`) uses --
// verified by enumerating all of U+0000..U+10FFFF in both runtimes and
// diffing. Legacy `\s` is NOT that set: it omits U+0085 (NEL) and wrongly
// includes U+FEFF, which is precisely the kind of quiet divergence between
// the two implementations this rule exists to avoid.
const WHITESPACE_RUN = /\p{White_Space}+/u;

/// The number of words in `text`. Pure: no ProseMirror, no DOM.
export function countWords(text: string): number {
  // Splitting yields empty strings for leading, trailing and repeated
  // whitespace; dropping them is what makes runs maximal.
  return text.split(WHITESPACE_RUN).filter((run) => run.length > 0).length;
}
