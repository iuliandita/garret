// app/ui/src/diff.ts
// What changed between a past version of a scene and the one on screen.
//
// WORD LEVEL, NOT CHARACTER LEVEL, and that is a legibility decision rather than
// an implementation convenience. A character diff of prose marks the middle of
// words - "manuscr[ipt|ipts]" - so a reader scanning a revision has to
// reassemble each word before they can judge it. A novelist comparing two drafts
// is asking which words moved, and the smallest unit that answers that question
// is a word.
//
// Pure: no DOM, no ProseMirror, no store. It takes the two plain-text
// projections and returns pieces; painting them is the history panel's job. That
// is what makes every rule here reachable from a test with no page.
import { countWords } from "./words";

export type DiffOp = "same" | "added" | "removed";

export interface DiffPiece {
  readonly op: DiffOp;
  readonly text: string;
}

/** The most cells a dynamic-programming table is allowed to hold.
 *
 *  LCS is O(n*m), and both dimensions are the writer's: a long scene against a
 *  version of it that was rewritten rather than edited puts thousands of words
 *  on each side with almost nothing in common, and the table is the product. At
 *  a million cells the pass is a few milliseconds and the `Uint32Array` behind
 *  it is about 4 MB, which is affordable on a surface the writer is looking at.
 *  Two 5,000-word sides would be 25 million cells and 100 MB, which is not - it
 *  is a visibly frozen window, and it arrives exactly when a writer is trying to
 *  recover work.
 *
 *  Nearly all of the agreement in an EDITED scene is at the two ends, and the
 *  common prefix and suffix come off before this budget is consulted, so what is
 *  measured against it is the genuinely divergent middle. Reaching it therefore
 *  means the two versions really are close to disjoint, and for those two texts
 *  "this was replaced by that" is also the only true summary a word diff could
 *  give.
 */
export const MAX_LCS_CELLS = 1_000_000;

// A token is one run of non-whitespace TOGETHER WITH the whitespace that
// follows it, plus a leading-whitespace token when the text opens with one. That
// shape is what makes the round trip exact: the alternation covers every
// character in order and consumes no character twice, so joining the tokens
// reproduces the input, and joining a diff's pieces reproduces the side they
// came from.
//
// `\p{White_Space}` is the same class as `words.ts`, which records why: legacy
// `\s` omits U+0085 and includes U+FEFF, so it disagrees with Rust's
// `char::is_whitespace` and therefore with the word count this application
// shows. There must not be a second whitespace rule in the page.
const TOKEN = /[^\p{White_Space}]+\p{White_Space}*|\p{White_Space}+/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

// Tokens are compared by their WHOLE text, trailing whitespace included, which
// costs one piece of precision and buys the round trip. A word whose following
// space became a paragraph break is reported as removed and re-added rather than
// unchanged, because a `same` piece has one text and would otherwise have to
// stand for two different strings - and then joining the pieces would reproduce
// neither side exactly. Only the one token at the seam is affected; the rest of
// the paragraph is untouched.
function push(pieces: DiffPiece[], op: DiffOp, text: string): void {
  if (text === "") return;
  const last = pieces[pieces.length - 1];
  // Adjacent tokens sharing a verdict are one piece. A reader sees runs, not
  // words, and the panel paints one span per piece.
  if (last !== undefined && last.op === op) {
    pieces[pieces.length - 1] = { op, text: last.text + text };
    return;
  }
  pieces.push({ op, text });
}

/** The divergent middle, once the ends have been taken off. */
function diffMiddle(a: readonly string[], b: readonly string[], out: DiffPiece[]): void {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return;
  if (n === 0) {
    push(out, "added", b.join(""));
    return;
  }
  if (m === 0) {
    push(out, "removed", a.join(""));
    return;
  }
  if (n * m > MAX_LCS_CELLS) {
    // The stated fallback: one removed run and one added run. Removed first, so
    // the reading order is always "what was there, then what is there now".
    push(out, "removed", a.join(""));
    push(out, "added", b.join(""));
    return;
  }

  // `table[i][j]` is the length of the longest common subsequence of the
  // SUFFIXES a[i..] and b[j..]. Filled from the end so the walk below can go
  // forwards, which keeps the pieces in document order with no reversal.
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(out, "same", a[i]);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      // A tie is spent on the removal, so a replacement always reads as the old
      // words followed by the new ones rather than alternating between them.
      push(out, "removed", a[i]);
      i++;
    } else {
      push(out, "added", b[j]);
      j++;
    }
  }
  while (i < n) push(out, "removed", a[i++]);
  while (j < m) push(out, "added", b[j++]);
}

/** Word-level diff of two plain-text projections of a scene.
 *
 *  Joining the text of every piece that is not `added` reproduces `before`
 *  exactly; joining every piece that is not `removed` reproduces `after`. That
 *  property is the contract the panel rests on - a rendering built from these
 *  pieces is a rendering of the real text, not an approximation of it.
 *
 *  A real LCS over the middle, so a paragraph inserted between two others is
 *  reported as an insertion and everything after it stays `same`. A line-by-line
 *  or positional comparison marks the whole tail as changed, which for a writer
 *  who added a scene-opening paragraph is a diff that says nothing.
 */
export function diffWords(before: string, after: string): DiffPiece[] {
  const a = tokenize(before);
  const b = tokenize(after);

  // The common ends, taken off first. For an edited scene this is nearly all of
  // it, and what it leaves is what the budget above is measured against.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const pieces: DiffPiece[] = [];
  if (head > 0) push(pieces, "same", a.slice(0, head).join(""));
  diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), pieces);
  if (tail > 0) push(pieces, "same", a.slice(a.length - tail).join(""));
  return pieces;
}

/** Totals a reader can act on. */
export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
}

/** WORDS, not pieces.
 *
 *  A piece is a run of whatever length the diff happened to produce, so counting
 *  pieces would report a number that changes with the shape of the edit rather
 *  than with its size. `countWords` is the application's one word rule, so a
 *  whitespace-only piece - the leading indent of a text, or a paragraph break
 *  the diff attributed to one side - contributes nothing, which is what a reader
 *  told "12 words added" expects.
 */
export function summarize(pieces: readonly DiffPiece[]): DiffSummary {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const piece of pieces) {
    const words = countWords(piece.text);
    if (piece.op === "added") added += words;
    else if (piece.op === "removed") removed += words;
    else unchanged += words;
  }
  return { added, removed, unchanged };
}
