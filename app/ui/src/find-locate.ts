// app/ui/src/find-locate.ts
// Where in the open document is the word the search found?
//
// The host already knows the byte offset -- it needs one to cut the snippet --
// and this module exists rather than that number being returned because the two
// sides do not share a coordinate system. The host's offset is into a flat text
// projection of the stored body; the editor needs a ProseMirror position. The
// number would cross the boundary and leave the hard half of the problem
// exactly where it was.
//
// Nothing here touches the DOM or the view. It is a pure function of a document
// and a query, which is what makes the folding rule below testable at all.
import type { Node as PmNode } from "prosemirror-model";

/** Fold one string for comparison, ONE CODE POINT AT A TIME.
 *
 *  Not `text.toLowerCase()`, and the difference is not academic.
 *  `String.prototype.toLowerCase` implements Unicode SpecialCasing, which
 *  includes the Final_Sigma condition: it lowercases a word-final capital sigma
 *  to the final form. The host folds with Rust's `char::to_lowercase`, which is
 *  context-free and always yields the medial form. Fold the whole string here
 *  and a Greek word matches in the results panel and then cannot be located in
 *  the document at all -- the host says "in this scene" and this module says
 *  "nowhere in it".
 *
 *  Folding one code point at a time removes the context the special casing
 *  needs, which is exactly what makes the two agree. `[...text]` iterates code
 *  points rather than UTF-16 units, so a surrogate pair folds as one character
 *  instead of two halves. */
export function foldForFind(text: string): string {
  let out = "";
  for (const codePoint of text) out += codePoint.toLowerCase();
  return out;
}

export interface MatchRange {
  /** ProseMirror position of the first character of the match. */
  from: number;
  /** ProseMirror position after its last character. */
  to: number;
}

/** The folded projection of a document, plus a document position for every
 *  folded UTF-16 code unit.
 *
 *  Two parallel arrays rather than one offset map, because folding is not
 *  length-preserving: `İ` folds to two code units, so an index into the folded
 *  text is not an index into the original and a match's end cannot be derived
 *  by adding the query's length to its start. The host's `fold_with_offsets`
 *  carries the same structure for the same reason -- there a wrong index cuts a
 *  string off a character boundary and PANICS, which poisons the store mutex
 *  and closes the writer's window. Here it would quietly select the wrong span,
 *  which is no better for being quiet. */
interface Projection {
  folded: string;
  starts: number[];
  ends: number[];
}

/** RESTATES `store::append_node`, which reads: a text node contributes its
 *  text; any other node contributes one space before its content, unless
 *  nothing has been emitted yet, and then its children.
 *
 *  Restated and not shared, like the word-count rule in `words.ts`/`words.rs`:
 *  there is no build step joining the page and the host, so a change to one
 *  without the other must break a test rather than pass silently.
 *
 *  The separator is SYNTHETIC -- it is not in the document and holds no
 *  position. Both of its bounds are the position where the block's content
 *  starts, so a match beginning at a paragraph boundary selects from the first
 *  real character rather than from somewhere a caret cannot go. */
function project(doc: PmNode): Projection {
  const out: Projection = { folded: "", starts: [], ends: [] };

  const push = (text: string, from: number, to: number): void => {
    const folded = foldForFind(text);
    out.folded += folded;
    for (let i = 0; i < folded.length; i++) {
      out.starts.push(from);
      out.ends.push(to);
    }
  };

  const walk = (node: PmNode, pos: number): void => {
    if (node.isText) {
      const text = node.text ?? "";
      // Per CODE POINT, so that a fold which changes length still maps every
      // unit it produces back to the character it came from. `offset` walks
      // UTF-16 units because that is what a ProseMirror text node's size counts
      // and therefore what its positions step by.
      let offset = 0;
      for (const codePoint of text) {
        push(codePoint, pos + offset, pos + offset + codePoint.length);
        offset += codePoint.length;
      }
      return;
    }
    // The block separator. `pos + 1` is inside the node, where its content
    // begins - the node itself occupies `pos`.
    if (out.folded.length > 0) push(" ", pos + 1, pos + 1);
    node.forEach((child, childOffset) => {
      // +1 for the opening token of `node`. The document node is at position -1
      // by this arithmetic, which is correct: its first child starts at 0.
      walk(child, pos + 1 + childOffset);
    });
  };

  walk(doc, -1);
  return out;
}

/** Every non-overlapping occurrence of `query` in `doc`, left to right.
 *
 *  Non-overlapping and left-to-right because that is what replace-all has to
 *  mean: "aa" in "aaaa" is two replacements, not three. The scan advances past
 *  the whole match rather than past its first unit, so a query that is a prefix
 *  of itself cannot make the result depend on how the caller iterates.
 *
 *  ONE PROJECTION for the whole scan. `locateFirstMatch` projects the document
 *  too, so calling it in a loop would re-project once per match - O(n * matches)
 *  over a scene that could be the longest chapter in the book. */
export function locateMatches(doc: PmNode, query: string): MatchRange[] {
  const needle = foldForFind(query);
  // A TERMINATION guard, and this is where it differs from the identical-looking
  // line in `locateFirstMatch` below - that one is a cost guard and says so.
  // Here the scan advances by `needle.length`, so an empty needle advances by
  // ZERO and `indexOf("")` keeps returning the same index: the loop never ends
  // and the window locks up. Proven by mutation - deleting this line does not
  // fail the suite, it HANGS it.
  if (needle.length === 0) return [];
  const { folded, starts, ends } = project(doc);
  const out: MatchRange[] = [];
  let at = folded.indexOf(needle);
  while (at >= 0) {
    const from = starts[at];
    const to = ends[at + needle.length - 1];
    // A unit with no position is a fold that produced more units than the
    // projection mapped, which would be a bug in `project`. Skipping the match
    // rather than throwing keeps a replace-all from taking the window down over
    // one unlocatable occurrence; the count the caller reports is then honestly
    // lower than the panel's total, which is the visible symptom.
    if (from !== undefined && to !== undefined) out.push({ from, to });
    at = folded.indexOf(needle, at + needle.length);
  }
  return out;
}

/** The first occurrence of `query` in `doc`, or null.
 *
 *  Null is a real answer and not an error. The page can fail to locate what the
 *  host found - a query spanning a paragraph boundary, a body edited between
 *  the search and the click - and the correct response is to open the document
 *  and leave the caret alone. */
export function locateFirstMatch(doc: PmNode, query: string): MatchRange | null {
  const needle = foldForFind(query);
  // A COST guard, not a correctness one, and mutation-tested as such: removing
  // it does not change any answer, because `indexOf("")` returns 0 and the end
  // lookup below then reads index -1 and finds nothing. What it buys is not
  // projecting a whole scene to answer a question with no answer. Stated rather
  // than left to look like a null check that no test can fail.
  if (needle.length === 0) return null;
  const { folded, starts, ends } = project(doc);
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  const from = starts[at];
  const to = ends[at + needle.length - 1];
  if (from === undefined || to === undefined) return null;
  return { from, to };
}
