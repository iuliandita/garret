// app/ui/src/word-at.ts
// The word around one offset in a run of text, for "add this to the
// dictionary". Pure: takes a string and an offset, answers a range in it.
//
// A WORD IS LETTERS, MARKS AND THE APOSTROPHES INSIDE A NAME. Digits are not
// spelled and the checker never underlines them; a hyphen ends a word because
// enchant checks each side of one on its own, so "half-remembered" added whole
// would sit in the list and both halves would stay underlined. The two
// apostrophes (U+0027, U+2019) are kept only BETWEEN letters -- "O'Neil" and
// "d'Artagnan" are one word to the checker, a trailing quote is not.

const LETTER = /[\p{L}\p{M}]/u;
// Both written as escapes: the string guard reads a bare quote in a regex
// as the start of a sentence.
const APOSTROPHE = /[\u0027\u2019]/;

function letterAt(text: string, at: number): boolean {
  const ch = text[at];
  return ch !== undefined && LETTER.test(ch);
}

/** Whether `at` is part of a word given its neighbours: a letter, or an
 *  apostrophe with a letter on both sides. */
function wordCharAt(text: string, at: number): boolean {
  if (letterAt(text, at)) return true;
  const ch = text[at];
  if (ch === undefined || !APOSTROPHE.test(ch)) return false;
  return letterAt(text, at - 1) && letterAt(text, at + 1);
}

export interface WordRange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** The word touching `offset` -- the one it is inside, or the one it sits at
 *  the end of, which is where a caret rests after typing it. Null when there
 *  is no letter on either side. */
export function wordAround(text: string, offset: number): WordRange | null {
  let at = offset;
  if (!wordCharAt(text, at)) {
    if (at > 0 && wordCharAt(text, at - 1)) at -= 1;
    else return null;
  }
  let from = at;
  while (from > 0 && wordCharAt(text, from - 1)) from -= 1;
  let to = at + 1;
  while (to < text.length && wordCharAt(text, to)) to += 1;
  return { from, to, text: text.slice(from, to) };
}

/** Whether a selection's text is exactly one word, which is the only thing
 *  the dictionary control offers to add. Surrounding whitespace is forgiven
 *  because a double-click in WebKit selects the trailing space with the word. */
export function isOneWord(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const range = wordAround(trimmed, 0);
  return range !== null && range.from === 0 && range.to === trimmed.length;
}
