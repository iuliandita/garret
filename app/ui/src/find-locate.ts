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
import { documentFields } from "./document-projections";

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

export interface FieldLocator {
  item_id?: string;
  instance_id: string | null;
  field: "prose" | "note" | "caption" | "alt";
  from: number;
  to: number;
}

export interface FieldMatch extends MatchRange {
  locator: FieldLocator;
  text: string;
}

function offsets(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  let offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const codePoint of text) {
    const value = foldForFind(codePoint);
    folded += value;
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + codePoint.length); }
    offset += codePoint.length;
  }
  return { folded, starts, ends };
}

export function locateFieldMatches(doc: PmNode, query: string): FieldMatch[] {
  const needle = foldForFind(query);
  if (!needle) return [];
  const out: FieldMatch[] = [];
  for (const field of documentFields(doc)) {
    const { folded, starts, ends } = offsets(field.text);
    let at = folded.indexOf(needle);
    while (at >= 0) {
      const start = starts[at], end = ends[at + needle.length - 1];
      if (start !== undefined && end !== undefined) {
        const prose = field.field === "prose";
        const from = prose ? field.from + start : field.from;
        const to = prose ? field.from + end : field.to;
        out.push({ from, to, text: field.text, locator: { instance_id: field.instance_id, field: field.field,
          from: prose ? from : start, to: prose ? to : end } });
      }
      at = folded.indexOf(needle, at + needle.length);
    }
  }
  return out;
}

export function locateMatches(doc: PmNode, query: string): MatchRange[] {
  return locateFieldMatches(doc, query).filter(hit => hit.locator.field === "prose").map(({ from, to }) => ({ from, to }));
}

export function locateFirstMatch(doc: PmNode, query: string, locator?: FieldLocator): MatchRange | null {
  if (locator === undefined) return locateMatches(doc, query)[0] ?? null;
  const hit = locateFieldMatches(doc, query).find(hit =>
    hit.locator.field === locator.field && hit.locator.instance_id === locator.instance_id
      && hit.locator.from === locator.from && hit.locator.to === locator.to);
  return hit ? { from: hit.from, to: hit.to } : null;
}
